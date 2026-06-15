/**
 * Lambda function health checks.
 *
 * The upstream Compute stack does not publish individual Lambda function
 * names/ARNs as stack outputs. We discover them by listing all functions in
 * the region and filtering for ones belonging to Innovation Sandbox (prefixed
 * with "ISB-" or containing "InnovationSandbox-Compute").
 */
import {
  GetFunctionCommand,
  LambdaClient,
  ListFunctionsCommand,
} from '@aws-sdk/client-lambda';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

// These runtimes are EOL or deprecated.
const DEPRECATED_RUNTIMES = new Set([
  'nodejs14.x',
  'nodejs16.x',
  'nodejs18.x',
  'python3.7',
  'python3.8',
]);

describe('Lambda functions', () => {
  let discovered: string[] = [];
  const client = new LambdaClient({ region: env.hubRegion });

  beforeAll(async () => {
    // Paginate through all functions and collect ISB ones.
    let marker: string | undefined;
    do {
      const response = await client.send(
        new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }),
      );
      for (const fn of response.Functions ?? []) {
        const name = fn.FunctionName ?? '';
        if (
          name.startsWith('ISB-') ||
          name.includes('InnovationSandbox-Compute')
        ) {
          discovered.push(name);
        }
      }
      marker = response.NextMarker;
    } while (marker);
  });

  it('at least one ISB Lambda function exists in the region', () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it('all discovered Lambda functions are Active and not on deprecated runtimes', async () => {
    const failures: string[] = [];

    for (const functionName of discovered) {
      const response = await client.send(
        new GetFunctionCommand({ FunctionName: functionName }),
      );
      const config = response.Configuration;
      if (!config) {
        failures.push(`${functionName}: GetFunction returned no Configuration`);
        continue;
      }
      if (config.State !== 'Active') {
        failures.push(
          `${functionName}: State is ${config.State}, expected Active`,
        );
      }
      if (config.Runtime && DEPRECATED_RUNTIMES.has(config.Runtime)) {
        failures.push(
          `${functionName}: Runtime ${config.Runtime} is deprecated`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
