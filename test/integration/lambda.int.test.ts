/**
 * Lambda function health checks.
 *
 * The Compute stack publishes the names/ARNs of several key Lambda functions
 * as stack outputs. We assert each one exists, is in the `Active` state, and
 * runs on a supported runtime (i.e. nothing has fallen onto a deprecated
 * runtime version since the last deploy).
 *
 * The set of functions varies between upstream versions; we discover them
 * dynamically from stack outputs and skip any that aren't published.
 */
import {
  GetFunctionCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';

import { describeStack, loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

// Outputs that are commonly published by the upstream Compute stack and point
// at a Lambda function name or ARN. These names are best-effort - if upstream
// renames an output the test simply won't exercise that function (vs failing
// hard, which would create false negatives across solution upgrades).
const LAMBDA_OUTPUT_KEYS = [
  'LeaseManagerFunctionName',
  'LeaseMonitoringFunctionName',
  'AccountLifecycleFunctionName',
  'CleanupOrchestrationFunctionName',
  'AuthorizerFunctionName',
  'BudgetMonitoringFunctionName',
];

// These runtimes are EOL or deprecated. Catching them in CI lets us alert
// before AWS forces a runtime upgrade.
const DEPRECATED_RUNTIMES = new Set([
  'nodejs14.x',
  'nodejs16.x',
  'nodejs18.x',
  'python3.7',
  'python3.8',
]);

describe('Lambda functions', () => {
  let discovered: { key: string; functionName: string }[] = [];

  beforeAll(async () => {
    const stack = await describeStack(env.hubRegion, env.stackNames.compute);
    discovered = (stack.Outputs ?? [])
      .filter((o) => LAMBDA_OUTPUT_KEYS.includes(o.OutputKey ?? ''))
      .map((o) => ({
        key: o.OutputKey!,
        functionName: o.OutputValue!,
      }));
  });

  it('Compute stack publishes at least one Lambda function name', () => {
    // If every output is missing, either the upstream renamed all of them at
    // once (very unlikely) or the deploy is partial. Either way, fail loud.
    expect(discovered.length).toBeGreaterThan(0);
  });

  it('all discovered Lambda functions are Active and not on deprecated runtimes', async () => {
    const client = new LambdaClient({ region: env.hubRegion });
    const failures: string[] = [];

    for (const { key, functionName } of discovered) {
      const response = await client.send(
        new GetFunctionCommand({ FunctionName: functionName }),
      );
      const config = response.Configuration;
      if (!config) {
        failures.push(`${key}: GetFunction returned no Configuration`);
        continue;
      }
      if (config.State !== 'Active') {
        failures.push(
          `${key} (${functionName}): State is ${config.State}, expected Active`,
        );
      }
      if (config.Runtime && DEPRECATED_RUNTIMES.has(config.Runtime)) {
        failures.push(
          `${key} (${functionName}): Runtime ${config.Runtime} is deprecated`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
