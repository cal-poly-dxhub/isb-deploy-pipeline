import {
  CloudFormationClient,
  DescribeStacksCommand,
  Stack,
} from '@aws-sdk/client-cloudformation';

/**
 * Configuration read from the environment when integration tests run.
 *
 * The pipeline's IntegrationTest step sets these before invoking jest:
 *
 *   ISB_HUB_REGION              region of the deployed Compute/Data stacks
 *   ISB_NAMESPACE               namespace prefix used in stack names (default
 *                               matches the stage name lowercased)
 *
 * If you run the tests locally, export them in your shell (or pass them via
 * `--env`) and make sure your AWS credentials point at the hub account.
 */
export interface IntegrationTestEnv {
  readonly hubRegion: string;
  readonly namespace: string;
  readonly stackNames: {
    readonly accountPool: string;
    readonly idc: string;
    readonly data: string;
    readonly compute: string;
  };
}

export function loadIntegrationEnv(): IntegrationTestEnv {
  const hubRegion =
    process.env.ISB_HUB_REGION ??
    process.env.AWS_REGION ??
    'us-east-1';

  const namespace = process.env.ISB_NAMESPACE ?? 'dev';

  // The upstream solution names stacks "InnovationSandbox-<Component>" by
  // default. If a NAMESPACE is configured, it's appended.
  const suffix = namespace ? `-${namespace}` : '';
  return {
    hubRegion,
    namespace,
    stackNames: {
      accountPool: `InnovationSandbox-AccountPool${suffix}`,
      idc: `InnovationSandbox-IDC${suffix}`,
      data: `InnovationSandbox-Data${suffix}`,
      compute: `InnovationSandbox-Compute${suffix}`,
    },
  };
}

const cfnCache = new Map<string, Promise<Stack>>();

/**
 * Fetches a CloudFormation stack description, caching results across tests.
 * Throws a descriptive error if the stack doesn't exist (which usually means
 * the deploy step didn't run or used a different namespace).
 */
export async function describeStack(
  region: string,
  stackName: string,
): Promise<Stack> {
  const cacheKey = `${region}/${stackName}`;
  const cached = cfnCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    const client = new CloudFormationClient({ region });
    const response = await client.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const stack = response.Stacks?.[0];
    if (!stack) {
      throw new Error(
        `Stack ${stackName} not found in ${region}. ` +
          `Was the deploy step run? Check ISB_NAMESPACE matches the stage.`,
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
