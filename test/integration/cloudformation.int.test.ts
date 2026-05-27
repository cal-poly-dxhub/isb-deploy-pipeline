/**
 * CloudFormation stack health smoke tests.
 *
 * These verify that each of the four upstream Innovation Sandbox stacks
 * actually deployed and reached a healthy state. They are the broadest, fastest,
 * cheapest checks and should be the first signal if something has gone wrong.
 */
import { describeStack, loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('CloudFormation stacks', () => {
  describe.each([
    ['AccountPool', env.stackNames.accountPool],
    ['IDC', env.stackNames.idc],
    ['Data', env.stackNames.data],
    ['Compute', env.stackNames.compute],
  ])('%s stack', (_label, stackName) => {
    it(`exists and is in a healthy state`, async () => {
      const stack = await describeStack(env.hubRegion, stackName);
      // CloudFormation considers these "good" terminal states. ROLLBACK_*
      // and FAILED states would mean the deploy step didn't actually succeed.
      expect([
        'CREATE_COMPLETE',
        'UPDATE_COMPLETE',
        'IMPORT_COMPLETE',
        'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
      ]).toContain(stack.StackStatus);
    });

    it('has a non-empty Outputs section', async () => {
      const stack = await describeStack(env.hubRegion, stackName);
      // Every upstream stack publishes at least one Output (e.g. table name,
      // role ARN, distribution domain). An empty Outputs array would imply
      // a regression.
      expect(stack.Outputs?.length ?? 0).toBeGreaterThan(0);
    });
  });
});
