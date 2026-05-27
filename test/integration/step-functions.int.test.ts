/**
 * Step Functions tests.
 *
 * The Compute stack provisions a state machine that orchestrates account
 * cleanup (the AWS Nuke flow). We assert the state machine exists, has a
 * status of `ACTIVE`, and that recent executions (if any) didn't all fail.
 *
 * We deliberately do NOT trigger an execution here. That belongs in a
 * destructive functional test that controls a dedicated test account.
 */
import {
  DescribeStateMachineCommand,
  ListExecutionsCommand,
  SFNClient,
} from '@aws-sdk/client-sfn';

import { describeStack, loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

const STATE_MACHINE_OUTPUT_KEYS = [
  'CleanupStateMachineArn',
  'AccountCleanupStateMachineArn',
  'CleanupOrchestratorStateMachineArn',
];

describe('Step Functions', () => {
  let stateMachineArn: string | undefined;

  beforeAll(async () => {
    const stack = await describeStack(env.hubRegion, env.stackNames.compute);
    const output = (stack.Outputs ?? []).find((o) =>
      STATE_MACHINE_OUTPUT_KEYS.includes(o.OutputKey ?? ''),
    );
    stateMachineArn = output?.OutputValue;
  });

  it('Compute stack publishes a cleanup state machine ARN', () => {
    expect(stateMachineArn).toBeDefined();
    expect(stateMachineArn).toMatch(/^arn:aws:states:/);
  });

  it('state machine is ACTIVE', async () => {
    if (!stateMachineArn) return;
    const client = new SFNClient({ region: env.hubRegion });
    const response = await client.send(
      new DescribeStateMachineCommand({ stateMachineArn }),
    );
    expect(response.status).toBe('ACTIVE');
  });

  it('does not have a 100% failure rate over the last 20 executions', async () => {
    if (!stateMachineArn) return;
    const client = new SFNClient({ region: env.hubRegion });
    const response = await client.send(
      new ListExecutionsCommand({ stateMachineArn, maxResults: 20 }),
    );
    const executions = response.executions ?? [];
    if (executions.length === 0) {
      // Brand new install: nothing has run yet. That's fine.
      return;
    }
    const failed = executions.filter(
      (e) => e.status === 'FAILED' || e.status === 'TIMED_OUT',
    ).length;
    // Allow some flakiness (real-world workloads have transient AWS errors)
    // but if everything is failing, something is structurally broken.
    expect(failed / executions.length).toBeLessThan(1);
  });
});
