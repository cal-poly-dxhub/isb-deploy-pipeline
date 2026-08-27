import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, ".env.functional") });

const STATE_FILE = path.resolve(__dirname, ".functional-state.json");

/** Parse a comma-separated env var into a trimmed, de-duplicated list. */
function parseList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

export const config = {
  apiUrl: process.env.ISB_API_URL!,
  apiToken: process.env.ISB_API_TOKEN!,
  hubRegion: process.env.ISB_HUB_REGION ?? "us-west-2",
  namespace: process.env.ISB_NAMESPACE ?? "myisb",

  /**
   * Regions the sandbox is allowed to operate in — mirrors the deployment's
   * `AWS_REGIONS` / `IsbManagedRegions` setting. Resources are created and
   * their deletion is verified in each of these. Defaults to the hub region.
   */
  sandboxRegions: (() => {
    const list = parseList(process.env.ISB_SANDBOX_REGIONS);
    return list.length > 0 ? list : [process.env.ISB_HUB_REGION ?? "us-west-2"];
  })(),

  /** Smallest general-purpose instance type by default. */
  testInstanceType: process.env.ISB_TEST_INSTANCE_TYPE ?? "t3.nano",

  /**
   * Role the admin credentials assume inside the sandbox account to verify
   * deletion after the lease is terminated. Organizations creates
   * `OrganizationAccountAccessRole` in every member account by default.
   */
  adminAssumeRoleName:
    process.env.ISB_ADMIN_ASSUME_ROLE_NAME ?? "OrganizationAccountAccessRole",
};

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type CreatedResource = {
  region: string;
  bucket?: string;
  objectKey?: string;
  instanceId?: string;
  vpcId?: string;
  /** Only VPCs created by the functional test may be deleted. */
  createdDefaultVpc?: boolean;
};

function isMissingResourceError(err: any): boolean {
  return (
    err?.$metadata?.httpStatusCode === 404 ||
    [
      "InvalidInstanceID.NotFound",
      "InvalidVpcID.NotFound",
      "InvalidSubnetID.NotFound",
      "InvalidGroup.NotFound",
      "NoSuchBucket",
      "NotFound",
    ].includes(err?.name)
  );
}

/**
 * Return the account's default VPC, creating it when the account has none.
 * The returned flag ensures teardown never deletes a pre-existing VPC.
 */
export async function ensureDefaultVpc(
  region: string,
  credentials: AwsCredentials,
): Promise<{ vpcId: string; created: boolean }> {
  const { EC2Client, DescribeVpcsCommand, CreateDefaultVpcCommand } =
    await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region, credentials });
  const existing = await ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: "isDefault", Values: ["true"] }],
    }),
  );
  const existingVpcId = existing.Vpcs?.[0]?.VpcId;
  if (existingVpcId) return { vpcId: existingVpcId, created: false };

  const created = await ec2.send(new CreateDefaultVpcCommand({}));
  const vpcId = created.Vpc?.VpcId;
  if (!vpcId)
    throw new Error(`AWS did not return a default VPC ID in ${region}`);
  return { vpcId, created: true };
}

/** Record a resource as soon as any part of its provisioning succeeds. */
export function recordCreatedResource(resource: CreatedResource): void {
  const existing = (loadState().createdResources ?? []) as CreatedResource[];
  const previous = existing.find((item) => item.region === resource.region);
  const merged = { ...previous, ...resource };
  saveState({
    createdResources: [
      ...existing.filter((item) => item.region !== resource.region),
      merged,
    ],
  });
}

export function removeCreatedResource(region: string): void {
  const existing = (loadState().createdResources ?? []) as CreatedResource[];
  saveState({
    createdResources: existing.filter((item) => item.region !== region),
  });
}

async function deleteCreatedVpc(ec2: any, vpcId: string): Promise<void> {
  try {
    const { DeleteVpcCommand } = await import("@aws-sdk/client-ec2");
    await ec2.send(new DeleteVpcCommand({ VpcId: vpcId }));
    return;
  } catch (err: any) {
    if (isMissingResourceError(err)) return;
    if (err?.name !== "DependencyViolation") throw err;
  }

  // A default VPC normally has only AWS-created dependencies. Remove them
  // explicitly for SDK/API environments where DeleteVpc does not cascade.
  const {
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
    DeleteInternetGatewayCommand,
    DescribeSubnetsCommand,
    DeleteSubnetCommand,
    DescribeRouteTablesCommand,
    DeleteRouteTableCommand,
    DescribeSecurityGroupsCommand,
    DeleteSecurityGroupCommand,
    DeleteVpcCommand,
  } = await import("@aws-sdk/client-ec2");

  const gateways = await ec2.send(
    new DescribeInternetGatewaysCommand({
      Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
    }),
  );
  for (const gateway of gateways.InternetGateways ?? []) {
    const gatewayId = gateway.InternetGatewayId;
    if (!gatewayId) continue;
    try {
      await ec2.send(
        new DetachInternetGatewayCommand({
          InternetGatewayId: gatewayId,
          VpcId: vpcId,
        }),
      );
    } catch (err: any) {
      if (!isMissingResourceError(err)) throw err;
    }
    try {
      await ec2.send(
        new DeleteInternetGatewayCommand({ InternetGatewayId: gatewayId }),
      );
    } catch (err: any) {
      if (!isMissingResourceError(err)) throw err;
    }
  }

  const subnets = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    }),
  );
  for (const subnet of subnets.Subnets ?? []) {
    if (!subnet.SubnetId) continue;
    try {
      await ec2.send(new DeleteSubnetCommand({ SubnetId: subnet.SubnetId }));
    } catch (err: any) {
      if (!isMissingResourceError(err)) throw err;
    }
  }

  const routeTables = await ec2.send(
    new DescribeRouteTablesCommand({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    }),
  );
  for (const routeTable of routeTables.RouteTables ?? []) {
    if (
      !routeTable.RouteTableId ||
      routeTable.Associations?.some((association: any) => association.Main)
    )
      continue;
    try {
      await ec2.send(
        new DeleteRouteTableCommand({ RouteTableId: routeTable.RouteTableId }),
      );
    } catch (err: any) {
      if (!isMissingResourceError(err)) throw err;
    }
  }

  const securityGroups = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    }),
  );
  for (const group of securityGroups.SecurityGroups ?? []) {
    if (!group.GroupId || group.GroupName === "default") continue;
    try {
      await ec2.send(
        new DeleteSecurityGroupCommand({ GroupId: group.GroupId }),
      );
    } catch (err: any) {
      if (!isMissingResourceError(err)) throw err;
    }
  }

  try {
    await ec2.send(new DeleteVpcCommand({ VpcId: vpcId }));
  } catch (err: any) {
    if (!isMissingResourceError(err)) throw err;
  }
}

/**
 * Idempotently remove resources recorded by the functional test. Missing
 * resources are expected because account cleanup may already have removed
 * them; permission and dependency errors are surfaced to avoid silent leaks.
 */
export async function cleanupCreatedResource(
  resource: CreatedResource,
  credentials: AwsCredentials,
): Promise<void> {
  const {
    EC2Client,
    DescribeInstancesCommand,
    TerminateInstancesCommand,
    waitUntilInstanceTerminated,
  } = await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region: resource.region, credentials });
  const failures: string[] = [];

  if (resource.instanceId) {
    try {
      const result = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [resource.instanceId] }),
      );
      const instance = result.Reservations?.flatMap(
        (r: any) => r.Instances ?? [],
      )[0];
      const state = instance?.State?.Name;
      if (state && !["shutting-down", "terminated"].includes(state)) {
        await ec2.send(
          new TerminateInstancesCommand({ InstanceIds: [resource.instanceId] }),
        );
      }
      if (state && state !== "terminated") {
        await waitUntilInstanceTerminated(
          { client: ec2, maxWaitTime: 300 },
          { InstanceIds: [resource.instanceId] },
        );
      }
    } catch (err: any) {
      if (!isMissingResourceError(err)) {
        failures.push(`instance ${resource.instanceId}: ${String(err)}`);
      }
    }
  }

  if (resource.bucket) {
    const {
      S3Client,
      ListObjectsV2Command,
      DeleteObjectsCommand,
      DeleteBucketCommand,
    } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: resource.region, credentials });
    try {
      const objects = await s3.send(
        new ListObjectsV2Command({ Bucket: resource.bucket }),
      );
      const keys = (objects.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: resource.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
      await s3.send(new DeleteBucketCommand({ Bucket: resource.bucket }));
    } catch (err: any) {
      if (!isMissingResourceError(err)) {
        failures.push(`bucket ${resource.bucket}: ${String(err)}`);
      }
    }
  }

  if (resource.createdDefaultVpc && resource.vpcId) {
    try {
      await deleteCreatedVpc(ec2, resource.vpcId);
    } catch (err: any) {
      failures.push(`VPC ${resource.vpcId}: ${String(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Resource cleanup failed:\n${failures.join("\n")}`);
  }
}

/** Sandbox account credentials (from the SSO portal) used to create resources. */
export function sandboxCredentials(): AwsCredentials | undefined {
  const accessKeyId = process.env.ISB_SANDBOX_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ISB_SANDBOX_AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.ISB_SANDBOX_AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Admin credentials used by teardown cleanup and deletion verification. These
 * must be able to assume `config.adminAssumeRoleName` in the sandbox account
 * (e.g. Organizations management account credentials). Falls back to the
 * default AWS_* credentials if the ISB_ADMIN_* values are empty or unset.
 */
export function adminCredentials(): AwsCredentials | undefined {
  const accessKeyId =
    process.env.ISB_ADMIN_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.ISB_ADMIN_AWS_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken =
    process.env.ISB_ADMIN_AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Recover resources from an older or interrupted run that failed before state
 * was written. The bucket prefix and EC2 tag are unique to this test suite.
 */
export async function findUnrecordedFunctionalResources(
  region: string,
  accountId: string,
  credentials: AwsCredentials,
): Promise<CreatedResource[]> {
  const resources: CreatedResource[] = [];
  const { S3Client, ListBucketsCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region, credentials });
  const bucketPrefix = `isb-func-test-${accountId}-${region}-`.toLowerCase();
  const buckets = await s3.send(new ListBucketsCommand({}));
  for (const bucket of buckets.Buckets ?? []) {
    if (bucket.Name?.startsWith(bucketPrefix)) {
      resources.push({ region, bucket: bucket.Name });
    }
  }

  const { EC2Client, DescribeInstancesCommand } =
    await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region, credentials });
  const instances = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:isb:functional-test", Values: ["true"] },
        {
          Name: "instance-state-name",
          Values: [
            "pending",
            "running",
            "stopping",
            "stopped",
            "shutting-down",
          ],
        },
      ],
    }),
  );
  for (const reservation of instances.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (instance.InstanceId) {
        resources.push({ region, instanceId: instance.InstanceId });
      }
    }
  }
  return resources;
}

/**
 * Return credentials usable in the target sandbox account. If the configured
 * admin credentials already belong to that account (for example an SSO admin
 * role selected in the leased account), use them directly. Otherwise assume
 * the configured admin role cross-account from the management account.
 */
export async function assumeSandboxAdmin(
  accountId: string,
  region: string,
): Promise<AwsCredentials> {
  const { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } =
    await import("@aws-sdk/client-sts");
  const base = adminCredentials();
  if (!base) {
    throw new Error(
      "Admin credentials not configured. Set ISB_ADMIN_AWS_* (or AWS_*) in .env.functional.",
    );
  }
  const sts = new STSClient({ region, credentials: base });

  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (identity.Account === accountId) {
    return base;
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${config.adminAssumeRoleName}`;
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `isb-func-verify-${Date.now()}`,
      DurationSeconds: 3600,
    }),
  );
  const c = res.Credentials!;
  return {
    accessKeyId: c.AccessKeyId!,
    secretAccessKey: c.SecretAccessKey!,
    sessionToken: c.SessionToken!,
  };
}

async function functionalResourceExists(
  resource: CreatedResource,
  credentials: AwsCredentials,
): Promise<boolean> {
  if (resource.instanceId) {
    const { EC2Client, DescribeInstancesCommand } =
      await import("@aws-sdk/client-ec2");
    const ec2 = new EC2Client({ region: resource.region, credentials });
    try {
      const result = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [resource.instanceId] }),
      );
      const instance = result.Reservations?.flatMap(
        (reservation) => reservation.Instances ?? [],
      )[0];
      const state = instance?.State?.Name;
      if (instance && state !== "terminated" && state !== "shutting-down") {
        return true;
      }
    } catch (error: any) {
      if (error?.name !== "InvalidInstanceID.NotFound") throw error;
    }
  }

  if (resource.bucket) {
    const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: resource.region, credentials });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: resource.bucket }));
      return true;
    } catch (error: any) {
      const missing =
        error?.$metadata?.httpStatusCode === 404 ||
        error?.name === "NotFound" ||
        error?.name === "NoSuchBucket";
      if (!missing) throw error;
    }
  }

  if (resource.createdDefaultVpc && resource.vpcId) {
    const { EC2Client, DescribeVpcsCommand } =
      await import("@aws-sdk/client-ec2");
    const ec2 = new EC2Client({ region: resource.region, credentials });
    try {
      const result = await ec2.send(
        new DescribeVpcsCommand({ VpcIds: [resource.vpcId] }),
      );
      if (result.Vpcs?.some((vpc) => vpc.VpcId === resource.vpcId)) {
        return true;
      }
    } catch (error: any) {
      if (error?.name !== "InvalidVpcID.NotFound") throw error;
    }
  }

  return false;
}

function resourceLabel(resource: CreatedResource): string {
  return [
    resource.instanceId && `EC2 ${resource.instanceId}`,
    resource.bucket && `S3 ${resource.bucket}`,
    resource.vpcId && `VPC ${resource.vpcId}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Enforce the Nuke contract: detect leftovers first, then make a best-effort
 * safety cleanup while still throwing so the test reports that Nuke failed.
 */
export async function enforceFunctionalCleanup(
  accountId: string,
  regions: string[],
  recordedResources: CreatedResource[],
): Promise<void> {
  const failures: string[] = [];
  const allRegions = [
    ...new Set([
      ...regions,
      ...recordedResources.map((resource) => resource.region),
    ]),
  ];
  const recordedKeys = new Set(
    recordedResources.flatMap((resource) =>
      [resource.instanceId, resource.bucket, resource.vpcId].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  for (const region of allRegions) {
    let credentials: AwsCredentials;
    try {
      credentials = await assumeSandboxAdmin(accountId, region);
    } catch (error) {
      failures.push(
        `${region}: unable to obtain admin credentials: ${String(error)}`,
      );
      continue;
    }

    const recorded = recordedResources.filter(
      (resource) => resource.region === region,
    );
    for (const resource of recorded) {
      let exists = false;
      try {
        exists = await functionalResourceExists(resource, credentials);
      } catch (error) {
        failures.push(
          `${region}: unable to inspect ${resourceLabel(resource)}: ${String(error)}`,
        );
        continue;
      }
      if (!exists) continue;

      let cleanupResult = "safety cleanup completed";
      try {
        await cleanupCreatedResource(resource, credentials);
      } catch (error) {
        cleanupResult = `safety cleanup failed: ${String(error)}`;
      }
      failures.push(
        `${region}: Nuke left ${resourceLabel(resource)}; ${cleanupResult}`,
      );
    }

    let unrecorded: CreatedResource[];
    try {
      unrecorded = (
        await findUnrecordedFunctionalResources(region, accountId, credentials)
      ).filter(
        (resource) =>
          ![resource.instanceId, resource.bucket, resource.vpcId].some(
            (value) => value && recordedKeys.has(value),
          ),
      );
    } catch (error) {
      failures.push(
        `${region}: unable to scan for unrecorded resources: ${String(error)}`,
      );
      continue;
    }

    for (const resource of unrecorded) {
      let cleanupResult = "safety cleanup completed";
      try {
        await cleanupCreatedResource(resource, credentials);
      } catch (error) {
        cleanupResult = `safety cleanup failed: ${String(error)}`;
      }
      failures.push(
        `${region}: Nuke left unrecorded ${resourceLabel(resource)}; ${cleanupResult}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Nuke cleanup verification failed:\n${failures.join("\n")}`,
    );
  }
}

/** Resolve the latest Amazon Linux 2023 x86_64 AMI in a region via SSM. */
export async function latestAmazonLinuxAmi(
  region: string,
  credentials: AwsCredentials,
): Promise<string> {
  const { SSMClient, GetParameterCommand } =
    await import("@aws-sdk/client-ssm");
  const ssm = new SSMClient({ region, credentials });
  const res = await ssm.send(
    new GetParameterCommand({
      Name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
    }),
  );
  return res.Parameter!.Value!;
}

export async function isbApi(
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const response = await fetch(`${config.apiUrl}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
      Origin: config.apiUrl.replace("/api", ""),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

export function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 10_000,
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await fn()) return resolve();
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    reject(new Error(`Timed out after ${timeoutMs}ms`));
  });
}

export function saveState(state: Record<string, any>) {
  const existing = loadState();
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ ...existing, ...state }, null, 2),
  );
}

export function loadState(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
