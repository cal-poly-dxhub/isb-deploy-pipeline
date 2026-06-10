import {
  CloudFormationClient,
  DescribeStacksCommand,
  Stack,
} from '@aws-sdk/client-cloudformation';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

/**
 * Configuration read from the environment when integration tests run.
 *
 * The pipeline's IntegrationTest step sets these before invoking jest:
 *
 *   ISB_HUB_REGION              region of the deployed Compute/Data stacks
 *   ISB_NAMESPACE               namespace prefix used in stack names (default
 *                               matches the stage name lowercased)
 *   ISB_ORG_MGT_ACCOUNT         org management account ID (for cross-account
 *                               stack queries)
 *   ISB_ORG_MGT_REGION          region of the deployed AccountPool/IDC stacks;
 *                               defaults to ISB_HUB_REGION
 *
 * If you run the tests locally, export them in your shell (or pass them via
 * `--env`) and make sure your AWS credentials point at the hub account.
 */
export interface IntegrationTestEnv {
  readonly hubRegion: string;
  readonly orgMgtRegion: string;
  readonly orgMgtAccount: string | undefined;
  readonly namespace: string;
  readonly stackNames: {
    /** Deployed to org management account */
    readonly accountPool: string;
    /** Deployed to IDC account (may be org mgmt or a separate account) */
    readonly idc: string;
    /** Deployed to hub account */
    readonly data: string;
    /** Deployed to hub account */
    readonly compute: string;
  };
}

export function loadIntegrationEnv(): IntegrationTestEnv {
  const hubRegion =
    process.env.ISB_HUB_REGION ??
    process.env.AWS_REGION ??
    'us-east-1';

  const orgMgtRegion = process.env.ISB_ORG_MGT_REGION ?? hubRegion;
  const orgMgtAccount = process.env.ISB_ORG_MGT_ACCOUNT;

  const namespace = process.env.ISB_NAMESPACE ?? 'dev';

  return {
    hubRegion,
    orgMgtRegion,
    orgMgtAccount,
    namespace,
    stackNames: {
      accountPool: 'InnovationSandbox-AccountPool',
      idc: 'InnovationSandbox-IDC',
      data: 'InnovationSandbox-Data',
      compute: 'InnovationSandbox-Compute',
    },
  };
}

const cfnCache = new Map<string, Promise<Stack>>();

/**
 * Returns a CloudFormation client. If `accountId` is provided and differs from
 * the current credentials, assumes InnovationSandboxIntegrationTestRole in
 * that account first.
 */
async function getCfnClient(
  region: string,
  accountId?: string,
): Promise<CloudFormationClient> {
  if (!accountId) {
    return new CloudFormationClient({ region });
  }
  const sts = new STSClient({ region });
  const resp = await sts.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/InnovationSandboxIntegrationTestRole`,
      RoleSessionName: 'integ-test-cross-account',
    }),
  );
  return new CloudFormationClient({
    region,
    credentials: {
      accessKeyId: resp.Credentials!.AccessKeyId!,
      secretAccessKey: resp.Credentials!.SecretAccessKey!,
      sessionToken: resp.Credentials!.SessionToken!,
    },
  });
}

/**
 * Fetches a CloudFormation stack description, caching results across tests.
 * Throws a descriptive error if the stack doesn't exist.
 *
 * @param region    AWS region to query
 * @param stackName CloudFormation stack name
 * @param accountId Optional account ID — if provided and different from the
 *                  default credentials, assumes a cross-account role.
 */
export async function describeStack(
  region: string,
  stackName: string,
  accountId?: string,
): Promise<Stack> {
  const cacheKey = `${accountId ?? 'default'}/${region}/${stackName}`;
  const cached = cfnCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    const client = await getCfnClient(region, accountId);
    const response = await client.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const stack = response.Stacks?.[0];
    if (!stack) {
      throw new Error(
        `Stack ${stackName} not found in ${region}` +
          (accountId ? ` (account ${accountId})` : '') +
          `. Was the deploy step run?`,
      );
    }
    return stack;
  })();
  cfnCache.set(cacheKey, promise);
  return promise;
}

/**
 * Looks up a single CloudFormation stack output value by key. Returns
 * undefined if the key is not present (lets callers decide whether to fail
 * the test or skip).
 */
export async function getStackOutput(
  region: string,
  stackName: string,
  outputKey: string,
): Promise<string | undefined> {
  const stack = await describeStack(region, stackName);
  return stack.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue;
}

/**
 * Looks up a stack output, throwing if it's missing.
 */
export async function requireStackOutput(
  region: string,
  stackName: string,
  outputKey: string,
): Promise<string> {
  const value = await getStackOutput(region, stackName, outputKey);
  if (!value) {
    throw new Error(
      `Stack ${stackName} is missing required output "${outputKey}". ` +
        `This indicates a regression in the upstream solution or a partial ` +
        `deploy.`,
    );
  }
  return value;
}
