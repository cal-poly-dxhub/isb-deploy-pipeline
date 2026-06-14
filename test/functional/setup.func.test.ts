/**
 * Category: Setup
 *
 * Creates a lease template and leases an account.
 * Run: npm run test:functional -- --testPathPattern=setup
 */
import { isbApi, saveState } from './helpers';

jest.setTimeout(60_000);

describe('Setup', () => {
  it('creates a lease template', async () => {
    const { status, data } = await isbApi('POST', '/leaseTemplates', {
      name: `Functional Test Template ${Date.now()}`,
      description: 'Auto-created by functional tests',
      maxSpend: 10,
      leaseDurationInHours: 24,
      budgetThresholds: [],
      durationThresholds: [],
      requiresApproval: false,
    });

    expect(status).toBe(201);
    const template = data.data;
    expect(template.uuid).toBeDefined();
    saveState({ leaseTemplateId: template.uuid });
    console.log(`✓ Lease template created: ${template.uuid}`);
  });

  it('leases an account', async () => {
    const { leaseTemplateId } = await import('./helpers').then((h) => h.loadState());
    expect(leaseTemplateId).toBeDefined();

    const { status, data } = await isbApi('POST', '/leases', {
      leaseTemplateUuid: leaseTemplateId,
      comments: 'Functional test lease',
    });

    expect(status).toBe(201);
    const lease = data.data;
    expect(lease.uuid).toBeDefined();
    expect(lease.awsAccountId).toBeDefined();

    const leaseId = lease.leaseId ?? Buffer.from(JSON.stringify({
      userEmail: lease.userEmail,
      uuid: lease.uuid,
    })).toString('base64');

    saveState({
      leaseId,
      leaseUuid: lease.uuid,
      leaseAccountId: lease.awsAccountId,
    });

    console.log(`✓ Lease created: ${lease.uuid}`);
    console.log(`✓ Account assigned: ${lease.awsAccountId}`);
    console.log(`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  Next: get sandbox credentials from SSO portal for account\n` +
      `  ${lease.awsAccountId}, add them to .env.functional, then run:\n` +
      `  npm run test:functional -- --testPathPattern=sandbox\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
    );
  });
});
