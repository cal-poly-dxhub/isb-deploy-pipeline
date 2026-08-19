/**
 * Category 2: Sandbox Provisioning
 *
 * Creates real resources in the leased sandbox account so teardown/cleanup has
 * something to remove, and the deletion-verification stage has something to
 * confirm is gone. In every supported region it:
 *   - launches the smallest EC2 instance (Amazon Linux 2023), and
 *   - creates an S3 bucket populated with a single empty `.txt` object.
 *
 * Requires sandbox credentials in .env.functional.
 * Run: npm run test:functional -- --testPathPattern=sandbox
 */
import {
  config,
  loadState,
  sandboxCredentials,
  latestAmazonLinuxAmi,
  ensureDefaultVpc,
  recordCreatedResource,
  removeCreatedResource,
  cleanupCreatedResource,
  CreatedResource,
} from "./helpers";

jest.setTimeout(300_000);

const creds = sandboxCredentials();

describe("Sandbox Provisioning", () => {
  it("has sandbox credentials and a leased account", () => {
    expect(creds).toBeDefined();
    const state = loadState();
    expect(state.leaseAccountId).toBeDefined();
    expect(config.sandboxRegions.length).toBeGreaterThan(0);
    console.log(`Account: ${state.leaseAccountId}`);
    console.log(`Regions: ${config.sandboxRegions.join(", ")}`);
    console.log(`Instance type: ${config.testInstanceType}`);
  });

  // One provisioning test per supported region.
  it.each(config.sandboxRegions)(
    "creates EC2 + populated S3 in %s",
    async (region) => {
      expect(creds).toBeDefined();
      const state = loadState();
      const accountId: string = state.leaseAccountId;
      const previous = (state.createdResources ?? []).find(
        (resource: CreatedResource) => resource.region === region,
      );

      // A previous failed run may have left a partial record. Clean it before
      // replacing the record so a retry cannot orphan the old resources.
      if (previous) {
        await cleanupCreatedResource(previous, creds!);
        removeCreatedResource(region);
      }

      const { S3Client, CreateBucketCommand, PutObjectCommand } =
        await import("@aws-sdk/client-s3");
      const { EC2Client, RunInstancesCommand } =
        await import("@aws-sdk/client-ec2");
      const resource: CreatedResource = { region };

      try {
        // EC2 RunInstances without a SubnetId requires a default VPC. Create
        // one only when absent, and remember whether it is ours to delete.
        const vpc = await ensureDefaultVpc(region, creds!);
        resource.vpcId = vpc.vpcId;
        resource.createdDefaultVpc = vpc.created;
        recordCreatedResource(resource);

        // --- S3: create a bucket and populate it with an empty .txt object ---
        const bucket =
          `isb-func-test-${accountId}-${region}-${Date.now()}`.toLowerCase();
        const objectKey = "functional-test.txt";
        const s3 = new S3Client({ region, credentials: creds });

        await s3.send(
          new CreateBucketCommand({
            Bucket: bucket,
            // us-east-1 must NOT include a LocationConstraint.
            ...(region === "us-east-1"
              ? {}
              : {
                  CreateBucketConfiguration: {
                    LocationConstraint: region as any,
                  },
                }),
          }),
        );
        resource.bucket = bucket;
        resource.objectKey = objectKey;
        recordCreatedResource(resource);

        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            Body: "", // empty .txt
            ContentType: "text/plain",
          }),
        );
        console.log(
          `✓ [${region}] S3 bucket ${bucket} populated with ${objectKey}`,
        );

        // --- EC2: launch the smallest instance from the latest AL2023 AMI ---
        const amiId = await latestAmazonLinuxAmi(region, creds!);
        const ec2 = new EC2Client({ region, credentials: creds });
        const run = await ec2.send(
          new RunInstancesCommand({
            ImageId: amiId,
            InstanceType: config.testInstanceType as any,
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [
              {
                ResourceType: "instance",
                Tags: [
                  { Key: "Name", Value: "isb-functional-test" },
                  { Key: "isb:functional-test", Value: "true" },
                ],
              },
            ],
          }),
        );
        const instanceId = run.Instances?.[0]?.InstanceId;
        expect(instanceId).toBeDefined();
        resource.instanceId = instanceId!;
        recordCreatedResource(resource);
        console.log(
          `✓ [${region}] EC2 instance ${instanceId} launched (${amiId})`,
        );
      } catch (error) {
        console.error(
          `✗ [${region}] provisioning failed; cleaning partial resources`,
        );
        try {
          await cleanupCreatedResource(resource, creds!);
          removeCreatedResource(region);
          console.log(`✓ [${region}] partial resources cleaned`);
        } catch (cleanupError) {
          // Keep the state record so teardown can retry with admin credentials.
          recordCreatedResource(resource);
          console.error(
            `✗ [${region}] partial-resource cleanup failed`,
            cleanupError,
          );
        }
        throw error;
      }
    },
  );

  it("summarises what was created", () => {
    const resources: CreatedResource[] = loadState().createdResources ?? [];
    expect(resources.length).toBe(config.sandboxRegions.length);
    console.log(
      `\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `  Provisioned ${resources.length} region(s):\n` +
        resources
          .map((r) => `    ${r.region}: ${r.instanceId}, s3://${r.bucket}`)
          .join("\n") +
        `\n\n` +
        `  Next: terminate the lease and let cleanup run:\n` +
        `  npm run test:functional -- --testPathPattern=teardown\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
    );
  });
});
