/**
 * Category 3: Teardown
 *
 * Terminates the lease, waits for the Innovation Sandbox cleanup (Nuke) to
 * return the account to Available, and fails if dummy resources remain. Any
 * leftovers receive best-effort safety cleanup after they are reported.
 *
 * Run: npm run test:functional -- --testPathPattern=teardown
 */
import {
  isbApi,
  config,
  loadState,
  saveState,
  pollUntil,
  enforceFunctionalCleanup,
  CreatedResource,
} from "./helpers";

jest.setTimeout(1_800_000); // 30 min — cleanup can be slow

describe("Teardown", () => {
  it("terminates the lease", async () => {
    const state = loadState();
    expect(state.leaseId).toBeDefined();

    const { status } = await isbApi(
      "POST",
      `/leases/${state.leaseId}/terminate`,
    );
    expect([200, 202, 204]).toContain(status);
    console.log("✓ Lease terminated; waiting for Innovation Sandbox cleanup");
  });

  it("account returns to Available", async () => {
    const state = loadState();
    expect(state.leaseAccountId).toBeDefined();

    await pollUntil(
      async () => {
        const { data } = await isbApi("GET", "/accounts");
        const accounts = data?.data?.result;
        const ours = accounts?.find(
          (a: any) => a.awsAccountId === state.leaseAccountId,
        );
        if (ours && ours.status !== "Available") {
          process.stdout.write(`  Account status: ${ours.status}        \r`);
        }
        return ours?.status === "Available";
      },
      1_800_000, // 30 minutes for Nuke/account cleanup
      15_000,
    );

    console.log("\n✓ Account returned to Available");
  });

  it("fails if Nuke left functional resources", async () => {
    const state = loadState();
    const resources = (state.createdResources ?? []) as CreatedResource[];
    await enforceFunctionalCleanup(
      state.leaseAccountId,
      config.sandboxRegions,
      resources,
    );
    saveState({ nukeCleanupVerified: true });
    console.log(
      "✓ Nuke removed all recorded and unrecorded functional resources",
    );
  });

  it("removes the lease template", async () => {
    const state = loadState();
    expect(state.leaseTemplateId).toBeDefined();

    const { status } = await isbApi(
      "DELETE",
      `/leaseTemplates/${state.leaseTemplateId}`,
    );
    expect([200, 202, 204]).toContain(status);
    console.log("✓ Lease template removed");
  });

  it("preserves state for deletion verification", () => {
    expect(loadState().nukeCleanupVerified).toBe(true);
    saveState({ teardownComplete: true });
    console.log(
      "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "  Nuke cleanup verified. Functional teardown complete. ✓\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
    );
  });
});
