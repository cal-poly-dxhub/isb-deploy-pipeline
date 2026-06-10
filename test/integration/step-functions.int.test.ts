/**
 * Step Functions tests.
 *
 * The Compute stack provisions state machines but does not publish their ARNs
 * as stack outputs. We discover them by listing state machines and matching
 * by naming convention (contains "AccountCleaner" or "InnovationSandbox").
 */
import {
  DescribeStateMachineCommand,
  ListExecutionsCommand,
  ListStateMachinesCommand,
  SFNClient,
} from '@aws-sdk/client-sfn';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('Step Functions', () => {
  const client = new SFNClient({ region: env.hubRegion });
  let stateMachineArn: string | undefined;

  beforeAll(async () => {
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new ListStateMachinesCommand({ nextToken }),
      );
      const match = (response.stateMachines ?? []).find(
        (sm) =>
          sm.name?.includes('AccountCleaner') ||
          sm.name?.includes('InnovationSandbox'),
      );
      if (match) {
        stateMachineArn = match.stateMachineArn;
        break;
      }
      nextToken = response.nextToken;
    } while (nextToken);
  });

  it('an account cleanup state machine exists', () => {
    expect(stateMachineArn).toBeDefined();
    expect(stateMachineArn).toMatch(/^arn:aws:states:/);
  });

  it('state machine is ACTIVE', async () => {
    if (!stateMachineArn) return;
    const response = await client.send(
      new DescribeStateMachineCommand({ stateMachineArn }),
    );
    expect(response.status).toBe('ACTIVE');
  });

  it('does not have a 100% failure rate over the last 20 executions', async () => {
    if (!stateMachineArn) return;
    const response = await client.send(
      new ListExecutionsCommand({ stateMachineArn, maxResults: 20 }),
    );
    const executions = response.executions ?? [];
    if (executions.length === 0) return; // brand new, nothing has run
    const failed = executions.filter(
      (e) => e.status === 'FAILED' || e.status === 'TIMED_OUT',
    ).length;
    expect(failed / executions.length).toBeLessThan(1);
  });
});
