/**
 * AWS Organizations tests for the AccountPool stack.
 *
 * The AccountPool stack creates a tree of OUs that hold sandbox accounts in
 * different lifecycle states (Available, Active, Frozen, Quarantine, etc.)
 * and attaches Service Control Policies that prevent users from doing
 * expensive/dangerous things in sandbox accounts.
 *
 * IMPORTANT: This test runs against the AWS Organizations API, which lives
 * in the Org Management account, NOT the hub account. Either:
 *
 *   a) Run it locally with credentials that can call AWS Organizations, or
 *   b) Configure the pipeline's IntegrationTest role to allow assumption of
 *      a role in the Org Management account with `organizations:Describe*`
 *      and `organizations:List*` permissions.
 *
 * To avoid spurious failures in the default (hub-credentialed) pipeline run,
 * this suite is skipped unless `ISB_RUN_ORG_TESTS=true`.
 */
import {
  ListOrganizationalUnitsForParentCommand,
  ListPoliciesCommand,
  ListPoliciesForTargetCommand,
  ListRootsCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

const enabled = process.env.ISB_RUN_ORG_TESTS === 'true';
const describeOrSkip = enabled ? describe : describe.skip;

describeOrSkip('AWS Organizations (AccountPool stack)', () => {
  // AWS Organizations API is global but only accessible via us-east-1 (or
  // your home region). Default to us-east-1 unless overridden.
  const client = new OrganizationsClient({
    region: env.orgMgtRegion ?? 'us-east-1',
  });

  it('the organization root has at least one InnovationSandbox OU', async () => {
    const roots = await client.send(new ListRootsCommand({}));
    const rootId = roots.Roots?.[0]?.Id;
    expect(rootId).toBeDefined();

    const ous = await client.send(
      new ListOrganizationalUnitsForParentCommand({ ParentId: rootId }),
    );
    const isbOus = (ous.OrganizationalUnits ?? []).filter((ou) =>
      (ou.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    expect(isbOus.length).toBeGreaterThan(0);
  });

  it('there is at least one InnovationSandbox SCP', async () => {
    const policies = await client.send(
      new ListPoliciesCommand({ Filter: 'SERVICE_CONTROL_POLICY' }),
    );
    const isbPolicies = (policies.Policies ?? []).filter((p) =>
      (p.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    expect(isbPolicies.length).toBeGreaterThan(0);
  });

  it('every InnovationSandbox OU has at least one SCP attached', async () => {
    const roots = await client.send(new ListRootsCommand({}));
    const rootId = roots.Roots?.[0]?.Id;
    const ous = await client.send(
      new ListOrganizationalUnitsForParentCommand({ ParentId: rootId }),
    );
    const isbOus = (ous.OrganizationalUnits ?? []).filter((ou) =>
      (ou.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    const offenders: string[] = [];
    for (const ou of isbOus) {
      if (!ou.Id) continue;
      const attached = await client.send(
        new ListPoliciesForTargetCommand({
          TargetId: ou.Id,
          Filter: 'SERVICE_CONTROL_POLICY',
        }),
      );
      if ((attached.Policies ?? []).length === 0) {
        offenders.push(ou.Name ?? ou.Id);
      }
    }
    expect(offenders).toEqual([]);
  });
});
