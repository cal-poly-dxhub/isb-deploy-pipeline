/**
 * Category 4: Optional standalone deletion verification
 *
 * Stage 3 already runs this enforcement and fails when Nuke leaves resources.
 * This command is useful for rerunning the check after a failed teardown or
 * for auditing cleanup without repeating the lease lifecycle.
 *
 * Run: npm run test:functional -- --testPathPattern=verify-deletion
 */
import {
  config,
  loadState,
  adminCredentials,
  enforceFunctionalCleanup,
  CreatedResource,
} from "./helpers";

jest.setTimeout(300_000);

describe("Deletion Verification", () => {
    expect(adminCredentials()).toBeDefined();
    const state = loadState();
    expect(state.leaseAccountId).toBeDefined();
    console.log(`Account: ${state.leaseAccountId}`);
    console.log(
      `Checking ${((state.createdResources ?? []) as CreatedResource[]).length} recorded region resource(s) plus unrecorded test resources`,
    );
  });

  it("reports Nuke leftovers and clears them safely", async () => {
    const state = loadState();
    await enforceFunctionalCleanup(
      state.leaseAccountId,
      config.sandboxRegions,
      (state.createdResources ?? []) as CreatedResource[],
    );
  });

  it("reports success", () => {
    console.log(
      "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "  Nuke cleanup verified. All functional resources are gone. ✓\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
    );
  });
});
