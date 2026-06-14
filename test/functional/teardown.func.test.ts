/**
 * Category 3: Teardown
 *
 * Terminates the lease, waits for cleanup, removes the template.
 * Run: npm run test:functional -- --testPathPattern=3-teardown
 */
import { isbApi, loadState, clearState, pollUntil } from './helpers';

jest.setTimeout(1_800_000); // 30 min — cleanup can be slow

describe('Teardown', () => {
  it('terminates the lease', async () => {
    const state = loadState();
    expect(state.leaseId).toBeDefined();

    const { status } = await isbApi('POST', `/leases/${state.leaseId}/terminate`);
    expect([200, 202, 204]).toContain(status);
    console.log('✓ Lease terminated');
  });

  it('account returns to Available', async () => {
    const state = loadState();
    expect(state.leaseAccountId).toBeDefined();

    await pollUntil(async () => {
      const { data } = await isbApi('GET', '/accounts');
      const accounts = data?.data?.result;
      const ours = accounts?.find((a: any) => a.awsAccountId === state.leaseAccountId);
      if (ours && ours.status !== 'Available') {
        process.stdout.write(`  Account status: ${ours.status}        \r`);
      }
      return ours?.status === 'Available';
    }, 900_000, 15_000);

    console.log('\n✓ Account returned to Available');
  });

  it('removes the lease template', async () => {
    const state = loadState();
    expect(state.leaseTemplateId).toBeDefined();

    const { status } = await isbApi('DELETE', `/leaseTemplates/${state.leaseTemplateId}`);
    expect([200, 202, 204]).toContain(status);
    console.log(`✓ Lease template removed`);
  });

  it('cleans up state file', () => {
    clearState();
    console.log(`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  All categories complete. Functional tests passed. ✓\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
    );
  });
});
