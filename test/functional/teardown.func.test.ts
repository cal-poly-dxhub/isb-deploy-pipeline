/**
 * Category 3: Teardown
 *
 * Terminates the lease, waits for the Innovation Sandbox cleanup (Nuke) to
 * return the account to Available or Cooldown, and fails if dummy resources remain. Any
 * leftovers receive best-effort safety cleanup after they are reported.
 *
 * Run: npm run test:functional -- --testPathPattern=teardown
 */
import {
  isbApi,
  config,
  loadState,
  normalizeLeaseId,
  saveState,
  pollUntil,
  enforceFunctionalCleanup,
  CreatedResource,
} from "./helpers";

jest.setTimeout(1_800_000); // 30 min — cleanup can be slow

describe("Teardown", () => {
  it("terminates the lease", async () => {
    const state = loadState();
    const leaseIdentifier = state.leaseId
      ? normalizeLeaseId(state.leaseId)
      : state.leaseUuid;
    expect(leaseIdentifier).toBeDefined();

    const { status, data } = await isbApi(
      "POST",
      `/leases/${leaseIdentifier}/terminate`,
    );
    if (![200, 202, 204].includes(status)) {
      throw new Error(
        `POST /leases/${leaseIdentifier}/terminate failed with ${status}: ${JSON.stringify(data)}`,
      );
    }
    saveState({ leaseTerminationRequested: true });
    console.log(
      "✓ Lease termination accepted; waiting for Innovation Sandbox cleanup",
    );
  });

  it("account returns to Available or Cooldown", async () => {
    const state = loadState();
    expect(state.leaseAccountId).toBeDefined();
    if (!state.leaseTerminationRequested) {
      throw new Error(
        "Lease termination was not accepted; refusing to poll or run cleanup while the lease is active",
      );
    }

    await pollUntil(
      async () => {
        const response = await isbApi("GET", "/accounts");
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `GET /accounts returned ${response.status}: ${JSON.stringify(response.data)}`,
          );
        }
        const accounts = response.data?.data?.result;
        const ours = accounts?.find(
          (a: any) => a.awsAccountId === state.leaseAccountId,
        );
        const status = ours?.status ?? "not found";
        return status === "Available" || status === "Cooldown";
      },
      1_800_000, // 30 minutes for Nuke/account cleanup
      15_000,
      `account ${state.leaseAccountId} to become Available or Cooldown`,
    );

    console.log("\n✓ Account returned to Available or entered Cooldown");
  });

  it("fails if Nuke left functional resources", async () => {
    const state = loadState();
    if (!state.leaseTerminationRequested) {
      throw new Error(
        "Lease termination was not accepted; refusing cleanup verification while the lease is active",
      );
    }
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
    if (!state.nukeCleanupVerified) {
      throw new Error(
        "Nuke cleanup was not verified; refusing to delete the lease template",
      );
    }

    const { status, data } = await isbApi(
      "DELETE",
      `/leaseTemplates/${state.leaseTemplateId}`,
    );
    if (![200, 202, 204].includes(status)) {
      throw new Error(
        `DELETE /leaseTemplates/${state.leaseTemplateId} failed with ${status}: ${JSON.stringify(data)}`,
      );
    }
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
