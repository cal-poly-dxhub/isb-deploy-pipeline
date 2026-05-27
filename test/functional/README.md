# Functional Tests

End-to-end tests that exercise the Innovation Sandbox solution by
**creating, modifying, and destroying state**. They are deliberately separate
from `test/integration/` because they:

- Take minutes to hours to complete.
- Mutate live infrastructure (create lease records, move accounts between OUs, trigger AWS Nuke runs).
- Can leave a half-recycled account behind if interrupted.
- Are unsafe to run on Prod by default.

## Running

These tests are gated on `RUN_FUNCTIONAL_TESTS=true`. Without that env var,
every test in this directory is skipped.

```bash
export RUN_FUNCTIONAL_TESTS=true
export ISB_HUB_REGION=us-east-1
export ISB_NAMESPACE=dev
export ISB_TEST_USER_EMAIL=tester+functional@example.com   # IDC user used to mint API tokens
npm run test:functional
```

## Suggested test scenarios

The following scenarios are good candidates but not yet implemented:

| Scenario | What it would do |
|---|---|
| Lease create -> Active OU | POST /leases via the API, wait for the lifecycle Lambda to move the account from Available -> Active OU. |
| Budget breach -> Frozen | Push a synthetic budget breach event onto the EventBridge bus, assert account moves from Active -> Frozen OU. |
| Lease termination -> Cleanup | DELETE /leases/<id>, assert the cleanup Step Functions execution starts and finishes within the timeout. |
| Quarantine path | Inject a non-deletable resource into the test account, terminate the lease, assert account ends up in Quarantine. |
| Eject account | Call the eject API, assert the account leaves the sandbox OU tree. |

## Why these aren't in `test/integration/`

The integration suite runs after every Compute deploy in the pipeline, on
every stage, including Prod. Anything in there must be:

- Read-only.
- Idempotent.
- Side-effect free.

Functional tests can't satisfy those constraints. Keep them here, gate them
behind explicit opt-in, and run them on a dedicated test environment.
