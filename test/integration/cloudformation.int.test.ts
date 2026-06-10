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
  // AccountPool and IDC are in the org management account/region; Data and
  // Compute are in the hub account/region.
  const orgAcct = env.orgMgtAccount;
  describe.each([
    ['AccountPool', env.stackNames.accountPool, env.orgMgtRegion, orgAcct],
    ['IDC', env.stackNames.idc, env.orgMgtRegion, orgAcct],
    ['Data', env.stackNames.data, env.hubRegion, undefined],
    ['Compute', env.stackNames.compute, env.hubRegion, undefined],
  ])('%s stack', (_label, stackName, region, accountId) => {
    it(`exists and is in a healthy state`, async () => {
      const stack = await describeStack(region, stackName, accountId);
      expect([
        'CREATE_COMPLETE',
        'UPDATE_COMPLETE',
        'IMPORT_COMPLETE',
        'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
      ]).toContain(stack.StackStatus);
    });

    it('has a non-empty Outputs section', async () => {
      const stack = await describeStack(region, stackName, accountId);
      expect(stack.Outputs?.length ?? 0).toBeGreaterThan(0);
    });
  });
});
