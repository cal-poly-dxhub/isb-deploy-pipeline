# Innovation Sandbox on AWS — CDK Deployment Pipeline

A self-mutating AWS CDK Pipeline that builds, tests, and deploys the [Innovation
Sandbox on AWS](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws/)
solution across multiple AWS accounts and stages (Dev / Staging / Prod).

## Prerequisites

- Node 24+ and npm 10+
- AWS CDK CLI 2.1139+ (`npm install -g aws-cdk`)
- An AWS account designated as the **tooling account** (where the pipeline lives)
- One or more sets of three AWS accounts per environment:
  - `orgManagement` — your AWS Organizations management account
  - `idc` — IAM Identity Center delegated admin account
  - `hub` — the account that hosts the web UI, API, and runtime
- A [CodeStar Connection](https://docs.aws.amazon.com/dtconsole/latest/userguide/connections-create-github.html)
  to GitHub (preferred over OAuth tokens)

## One-time Setup

### 1. Bootstrap the tooling account

```bash
export CDK_DEFAULT_ACCOUNT=<tooling-account-id>
export CDK_DEFAULT_REGION=us-east-1
npm run bootstrap:tooling
```

### 2. Bootstrap each target account with `--trust`

For every account referenced by the config (Org Mgmt, IDC, Hub for each
environment), run:

```bash
cdk bootstrap aws://<target-account-id>/<region> \
  --trust <tooling-account-id> \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

This creates the cross-account roles (`cdk-*-deploy-role-*`,
`cdk-*-file-publishing-role-*`, etc.) that the pipeline assumes when running
`cdk deploy`.

### 3. Create the pipeline deploy role in each cross-account target

For any target account that is **different** from the tooling account (e.g. a
separate Hub account), create an IAM role the pipeline can assume to deploy.
Run these commands while authenticated to each such account:

```bash
aws iam create-role --role-name InnovationSandboxPipelineDeployRole --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<tooling-account-id>:root"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy --role-name InnovationSandboxPipelineDeployRole --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

This is required because the upstream Innovation Sandbox CDK app is designed
for credential switching (not CDK cross-account deployment). The pipeline
assumes this role to "become" the target account before running `cdk deploy`.

### 4. (Optional) Pre-create the AWS Nuke ECR push role in each Hub account

If `buildAndPushNukeImage: true`, each Hub account needs an IAM role named
`InnovationSandboxEcrPushRole` that:

- Trusts the tooling account
- Has permission to push to ECR

Example trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<tooling-account-id>:root" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### 5. Create the integration test role in each account

The pipeline runs post-deploy integration tests that query deployed resources.
Create an `InnovationSandboxIntegrationTestRole` in **every account** that
hosts Innovation Sandbox stacks (Hub, Org Management, and IDC if separate):

```bash
# Run while authenticated to EACH target account (Hub, Org Mgmt, IDC)
aws iam create-role --role-name InnovationSandboxIntegrationTestRole --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<tooling-account-id>:root"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy --role-name InnovationSandboxIntegrationTestRole --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```

If the tooling account is the same as the Org Mgmt account, the trust policy
trusts itself — this works fine.

### 6. Create a CodeStar Connection to GitHub

In the tooling account, go to **Developer Tools → Settings → Connections** and
create a connection to your GitHub org. Copy the ARN.

### 7. Configure your pipeline

All pipeline configuration is read from environment variables (or a `.env`
file at the repository root). Copy the template and fill in your values:

```bash
cp .env.example .env
# then edit .env with your account IDs, CodeStar connection ARN, etc.
```

The most important variables:

| Variable                                                    | Required           | Description                                      |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| `TOOLING_ACCOUNT`                                           | yes                | 12-digit account where the pipeline runs         |
| `TOOLING_REGION`                                            | no                 | Defaults to `us-east-1`                          |
| `UPSTREAM_CODESTAR_CONNECTION_ARN`                          | yes                | ARN from step 6 (upstream repo)                  |
| `PIPELINE_CODESTAR_CONNECTION_ARN`                          | yes                | ARN from step 6 (this repo)                      |
| `DEV_ORG_MGT_ACCOUNT`, `DEV_IDC_ACCOUNT`, `DEV_HUB_ACCOUNT` | one stage required | Account IDs for the Dev wave                     |
| `STAGING_*` / `PROD_*`                                      | optional           | Same shape as Dev; omit any stage you don't need |
| `BUILD_AND_PUSH_NUKE_IMAGE`                                 | no                 | `true` to push a private AWS Nuke ECR image      |
| `NOTIFICATION_EMAILS`                                       | no                 | Comma-separated emails for pipeline failures     |

A stage is only included in the pipeline if all three of its account IDs are
set. Leaving Staging/Prod blank gives you a Dev-only pipeline. See
[`.env.example`](./.env.example) for the complete list with comments.

> Variables already set in your shell override values in `.env`. Useful for CI
> environments — drop the same vars into GitHub Actions / CodeBuild env config
> and you don't need a file checked in.

## Deploy

```bash
npm install
npm run build
npm test
npm run deploy:pipeline
```

After the first deploy the pipeline becomes self-mutating. Configuration lives
in SSM Parameter Store (`/isb-pipeline/config`). Update it by editing `.env`
and running:

```bash
npm run config:push
```

The script reads `TOOLING_REGION` from `.env` to target the correct region, and
skips the write when nothing changed (`FORCE=1` overrides).

Writing the parameter is all you need to do. The pipeline owns an EventBridge
rule on the SSM `Parameter Store Change` event, so **any** edit to the
parameter — via this script, the AWS console, or other tooling — starts a new
execution. The synth step loads the parameter _before_ it synthesises anything,
so the new values are baked into that same run rather than the one after it.

Set `TRIGGER_ON_CONFIG_CHANGE=false` to opt out of the automatic re-trigger, or
`CONFIG_PARAMETER_NAME` to use a different parameter.

> Parameter Store events are delivered on a best-effort basis. If a run does not
> appear within a minute or so, start one from the CodePipeline console —
> the config is read at synth time, so any execution picks up the latest value.

> **Run `npm run config:push` before the first pipeline execution.** The synth step
> reads _all_ of its configuration from the parameter, so the parameter has to
> exist before a run can succeed. `npm run deploy:pipeline` itself reads `.env`
> directly and does not need it.

### One config change, one execution

Per-stage configuration is **not** baked into the pipeline definition. During
synth, each stage's resolved values are written into the cloud assembly as
`isb-config-<Stage>.env`, and the deploy and integration-test steps mount the
synth output and source that file at runtime.

This matters because of how self-mutation interacts with
`RestartExecutionOnUpdate`. When config lives in the pipeline definition, every
config edit produces a CloudFormation diff, which triggers a self-mutation,
which restarts the pipeline — so one config change yields _two_ executions, and
the second can arrive while the first is parked on an approval. With config in
the artifact, editing `NAMESPACE`, `PARENT_OU_ID`, `AWS_REGIONS`,
`IDENTITY_STORE_ID`, `SSO_INSTANCE_ARN`, the IDC group names, `ALLOW_LISTED_IP_RANGES`,
`SAML_METADATA_URL`, `AWS_ACCESS_PORTAL_URL`, the AccountPool SCP customization
values, or other v1.3.0 context settings produces no pipeline diff at
all: one execution, no restart.

Changes that _are_ structural still self-mutate and restart, because they alter
the pipeline itself: account IDs and regions (they appear in the deploy step's
assume-role ARN and IAM policy), which stages exist, and the
`*_REQUIRE_MANUAL_APPROVAL` / `*_RUN_INTEGRATION_TESTS` /
`BUILD_AND_PUSH_NUKE_IMAGE` flags. Those are rare and deliberate.

Because the config file travels inside the artifact, every step of a given
execution sees the same frozen config — editing the parameter mid-run cannot
split one execution across two configurations.

Push changes to either this repo (pipeline definition) or the upstream
Innovation Sandbox repo to trigger a new run.

## Upgrading an existing deployment to v1.3.0

v1.3.0 is a breaking authentication upgrade: the web application moves from a
custom SAML/JWT flow to an Amazon Cognito user pool federated to IAM Identity
Center. The pipeline deploys the stacks in the required order — AccountPool,
IDC, Data, Compute — but an operator must collect two values before deployment
and reconfigure the existing SAML application after Data updates.

### Before starting the pipeline

1. In the existing ISB web UI, choose **Settings → General → Maintenance
   Mode**, turn it on, choose **Save**, and confirm. Administrators retain
   access; Managers and users are blocked during the update.
2. In the Organizations management account, open **AWS Organizations →
   Policies → Service control policies**. Compare each namespace-prefixed ISB
   SCP attached to the account-pool OU with the pre-v1.3 baseline. Move any
   direct edits into the matching stage variables:
   - extra `NotAction` entries → `*_ADDITIONAL_ALLOWED_SERVICES`
   - extra `ArnNotLike` role patterns → `*_ADDITIONAL_PRINCIPAL_EXCEPTIONS`
   - Bedrock inference-profile patterns →
     `*_BEDROCK_INFERENCE_PROFILE_PATTERNS`

   The AccountPool update overwrites direct console edits. Once represented by
   these CloudFormation parameters, the customizations persist on later runs.

3. In the IAM Identity Center account, open **IAM Identity Center →
   Applications → Customer managed**, then choose the existing Innovation
   Sandbox SAML 2.0 application. Copy **IAM Identity Center SAML metadata URL**.
4. In IAM Identity Center, copy **AWS access portal URL** from the Dashboard
   (for example, `https://d-xxxxxxxxxx.awsapps.com/start`).
5. Put both values into `.env` for every enabled pipeline stage, along with any
   SCP values identified above:

   ```dotenv
   DEV_SAML_METADATA_URL=https://portal.sso.<region>.amazonaws.com/saml/metadata/...
   DEV_AWS_ACCESS_PORTAL_URL=https://d-xxxxxxxxxx.awsapps.com/start
   # DEV_ADDITIONAL_ALLOWED_SERVICES=sts:*,support:*,tag:*
   # DEV_ADDITIONAL_PRINCIPAL_EXCEPTIONS=arn:aws:iam::*:role/CustomGovernanceRole*
   # DEV_BEDROCK_INFERENCE_PROFILE_PATTERNS=arn:aws:bedrock:*:*:inference-profile/us.*
   ```

6. Run `npm run config:push`. Confirm `/isb-pipeline/config` in the tooling
   account contains `DEV_SAML_METADATA_URL` and `DEV_AWS_ACCESS_PORTAL_URL`
   (or the corresponding enabled-stage prefix) before allowing the deployment
   to reach Data. These are required v1.3.0 parameters.

### Run the upgrade and reconfigure SAML

1. Start/release the pipeline and approve the stage after reviewing the diff.
2. Monitor **CloudFormation → Stacks** in each target account. The expected
   order is `InnovationSandbox-AccountPool`, `InnovationSandbox-IDC`,
   `InnovationSandbox-Data`, then `InnovationSandbox-Compute`.
3. When **InnovationSandbox-Data** reaches `UPDATE_COMPLETE` in the Hub account,
   open its **Outputs** tab and copy:
   - `CognitoAcsUrl`
   - `CognitoAudience`
4. In the IAM Identity Center account, open **IAM Identity Center →
   Applications → Customer managed → [the existing ISB application] → Actions
   → Edit configuration**. Under **Application metadata**, set:
   - **Application ACS URL** = Data output `CognitoAcsUrl`
   - **Application SAML audience** = Data output `CognitoAudience`

   Choose **Submit**. A mismatch produces a _SAML assertion audience mismatch_
   login error. The pipeline does not pause between Data and Compute, so this
   console edit can be completed while Compute runs or immediately afterward.

5. Wait for Compute and the pipeline integration tests to succeed. If Data
   rolls back, inspect its CloudFormation events; the automatic AppConfig-to-
   DynamoDB migration is transactional and does not modify the old config on a
   failed update.

### After the pipeline succeeds

1. Open the CloudFront ISB URL and sign in through IAM Identity Center. Verify
   an Administrator can open **Settings** and the Accounts/Leases pages.
2. In **Settings**, review every section. Migrated sections initially show
   `Last edited by system:migration`. The old AppConfig `GlobalConfig` and
   `ReportingConfig` profiles remain because of deletion protection but are no
   longer read; make future changes only in the web UI.
3. Review the new defaults before restoring users:
   - **Allow user lease termination** is on.
   - **Max requests per window** is 10 in a rolling 168-hour window.
   - **Account cooldown** defaults to 24 hours.
   - **On validation failure** defaults to `Silent`.
4. In **Settings → General → Maintenance Mode**, turn maintenance mode off,
   choose **Save**, and confirm.
5. If custom EventBridge/Lambda consumers parse ISB events, add
   `UserTerminated` and manual `AccountQuarantined` handling. For cleanup
   events, replace `stateMachineExecutionArn`/`stateMachineExecutionStartTime`
   with `executionArn`/`executionStartTime`.
6. Cost-allocation tag activation starts after Compute updates and can take up
   to 24 hours; no console action is required.

## Dual-Source Architecture

The pipeline uses **two GitHub source inputs**:

1. **This pipeline repo** (primary) — contains the CDK pipeline definition,
   integration tests, and configuration. Used for self-mutation and test steps.
2. **Upstream Innovation Sandbox repo** — contains the solution source code,
   CDK stacks, and Dockerfiles. Used for build/test/deploy steps.

Both sources trigger the pipeline on push. The CodeStar Connection must have
access to both repositories. Configure them via:

| Variable                                                                    | Description                      |
| --------------------------------------------------------------------------- | -------------------------------- |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH`                            | Upstream Innovation Sandbox repo |
| `PIPELINE_GITHUB_OWNER` / `PIPELINE_GITHUB_REPO` / `PIPELINE_GITHUB_BRANCH` | This pipeline repo               |

Because this is a CodePipeline **V2** pipeline, each source needs its own entry
in the pipeline's `Triggers` block. Those entries reference source actions _by
name_, so both actions are given fixed names — `PipelineRepoSource` and
`UpstreamRepoSource` — rather than the CDK default of `<owner>_<repo>`. Synth
fails fast if a trigger ever references an action that does not exist, since
CloudFormation accepts such a trigger happily and it simply never fires.

## How Runs Get Started

There are three ways an execution begins:

| Trigger                                   | Source                                      |
| ----------------------------------------- | ------------------------------------------- |
| Push to the tracked branch of either repo | CodeStar Connection webhook + V2 `Triggers` |
| Create/update of the config SSM parameter | EventBridge rule → `StartPipelineExecution` |
| Self-mutation changing the pipeline       | `RestartExecutionOnUpdate`                  |

The pipeline runs in `SUPERSEDED` execution mode, so a newer execution replaces
an older one still waiting to enter a stage.

## Manual Approvals

When a stage has `*_REQUIRE_MANUAL_APPROVAL=true`, the stage runs a
`Diff-<Stage>` step _before_ the approval and nothing is deployed until someone
approves:

```
Diff-Dev  →  Approve-Dev  →  Deploy AccountPool → IDC → Data → Compute → tests
```

`Diff-Dev` runs `cdk diff` for all four upstream stacks — re-assuming the deploy
role per stack, since they span up to three accounts — and publishes the result
to the artifact bucket at `diffs/<Stage>/latest.txt`. The approval carries a
link to that object in both `ExternalEntityLink` (the clickable link on the
console approval dialog) and `CustomData` (so it also appears in the approval
notification email).

### What's in the diff file

A raw `cdk diff` of this solution is dominated by churn that changes on _every_
build — rebuilt Lambda bundles show up as `Code.S3Key`, `aws:asset:path` and
`asset.<hash>` differences. Left unfiltered that trains reviewers to skim past
everything, including the parts that matter. So the file leads with a summary and
keeps the raw output below it:

```
Innovation Sandbox - pending changes
====================================
Generated:       2026-08-06T19:02:25Z
Upstream commit: abc1234
Namespace:       dev
Solution version: SO0284: v1.2.12 -> v1.2.15

>> This diff contains replacements, removals, IAM changes or errors.
>> Read the summary below before approving.

SUMMARY
-------
InnovationSandbox-Data (333333333333/us-west-2)
  resources: +1  -1  ~2
  !! 2 line(s) mention replacement/destruction - REVIEW CAREFULLY
       [~] AWS::DynamoDB::Table LeaseTable LeaseTable123 may be replaced
        └─ [~] TableName (requires replacement)
  !! resources are being REMOVED:
       [-] AWS::SQS::Queue OldQueue OldQueueXYZ
  !  IAM / security-group changes present
```

The summary surfaces, per stack:

| Signal                          | Why it matters                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `+ / - / ~` resource counts     | Scale of the change at a glance                                                                     |
| Replacement / destruction lines | A replaced DynamoDB table means lease state is recreated — the single most important thing to catch |
| Removed resources               | Deletions are irreversible                                                                          |
| IAM / security-group changes    | `cdk diff` prints dedicated tables when permissions broaden                                         |
| Parameter / output changes      | Alters how the four stacks wire together                                                            |
| Solution version                | A `USER_AGENT_EXTRA` bump means the upstream solution itself moved                                  |

A banner at the top states whether any of those were found, so an approval with
nothing but asset churn is obvious without reading further. The full per-stack
`cdk diff` follows under `FULL DIFF`.

The file is uploaded as `text/plain; charset=utf-8`. The charset matters: `cdk
diff` draws its tree with box-drawing characters, and without it browsers fall
back to a locale default and render `│` as `â”‚`.

A fixed `latest.txt` per stage is unambiguous rather than racy: CodePipeline
locks a stage while it holds an execution, so only one execution can ever be
sitting at a given stage's approval.

Reviewers need `s3:GetObject` on that prefix plus `kms:Decrypt` on the pipeline
artifact key, because the bucket is encrypted with a customer-managed key.

The diff is informational and never blocks a deploy: if a role cannot be assumed
or `cdk diff` fails for one stack, the problem is written into the diff output
and the remaining stacks are still processed. The full diff is also echoed into
the CodeBuild log as a fallback.

### Why an approval can wedge the pipeline (and what stops it)

Superseding only happens **between** stages. Per the CodePipeline docs, a stage
is _locked_ while it holds an execution, and "a stage with an approval action is
locked until the approval action is approved or rejected or has timed out." An
execution parked on `Approve-Dev` is therefore _inside_ the Dev stage, holding
its lock — newer executions stack up in front of it as **inbound** and can never
overtake it, no matter how many arrive. The pipeline sits there until a human
answers, or until the approval times out after seven days. That timeout is fixed
by CodePipeline and cannot be configured or disabled.

To restore the intent of `SUPERSEDED`, the stack deploys an **approval
unblocker** Lambda. On every pipeline/stage state change it checks for a pending
approval and, if a strictly newer execution is still in flight, rejects the
stale one. Rejection fails the action, which releases the stage lock, and the
waiting execution moves in. The rejection comment records which execution
unblocked it.

It is deliberately narrow:

- Only approval actions that exist in the built pipeline are ever touched; their
  names are discovered at synth time, not guessed.
- An approval is rejected **only** when a newer execution is genuinely waiting.
  A lone pending approval keeps waiting for a human indefinitely.
- Nothing is stopped or abandoned, so an in-flight CloudFormation deploy is
  never interrupted.
- `PutApprovalResult` permission is scoped to the specific
  `<pipeline>/<stage>/<action>` ARNs.

Set `UNBLOCK_STALE_APPROVALS=false` to disable it and accept the stage lock.

With the unblocker in place the seven-day timeout stops mattering in practice: a
timeout also releases the lock, and by then any waiting execution has already
taken over. The remaining case — an approval that times out with nothing queued
behind it — leaves the pipeline idle, and any of the triggers above starts it
again.

Failure notifications include `manual-approval-failed` and
`pipeline-execution-superseded` so none of this is silent.

> If you don't actually need a human gate on Dev, setting
> `DEV_REQUIRE_MANUAL_APPROVAL=false` removes this whole class of problem for the
> stage that changes most often.

## Project Layout

```
.
├── bin/
│   └── pipeline-app.ts              # CDK app entrypoint
├── lib/
│   ├── pipeline-stack.ts            # Main pipeline stack
│   ├── config/
│   │   ├── environment-config.ts    # TypeScript types
│   │   ├── pipeline-config.ts       # Default config
│   │   └── stage-config-file.ts     # Per-stage config carried in the artifact
│   ├── lambda/
│   │   └── approval-unblocker/      # Frees a stage lock held by a stale approval
│   │       ├── index.mjs            # Handler (AWS calls)
│   │       └── select.mjs           # Pure decision logic
│   ├── stages/
│   │   └── innovation-sandbox-wave.ts  # Per-stage wave assembly
│   └── steps/
│       ├── deploy-step.ts           # Reusable per-stack deploy step
│       ├── diff-step.ts             # Pre-approval `cdk diff`, published to S3
│       ├── nuke-image-step.ts       # AWS Nuke ECR build/push
│       └── integration-test-step.ts # Post-deploy smoke tests
├── scripts/
│   ├── load_ssm_config.sh          # Synth-time loader for the SSM config (pre-npm-ci)
│   ├── render_stage_diff.sh        # Multi-account `cdk diff` for approvals
│   └── update-ssm.ts               # Publish .env to SSM (`npm run config:push`)
├── test/
│   ├── pipeline-stack.test.ts       # Unit tests (no AWS calls)
│   ├── stage-config-file.test.ts    # Stage config file rendering
│   ├── update-ssm.test.ts           # .env parsing / serialisation / region
│   ├── approval-unblocker.test.ts   # Approval unblocker decision logic
│   ├── support/
│   │   └── check-approval-select.mjs  # ESM assertions run by the test above
│   ├── integration/                 # Integration tests (real AWS calls)
│   │   ├── support/test-env.ts
│   │   ├── cloudformation.int.test.ts
│   │   ├── api-gateway.int.test.ts
│   │   ├── web-ui.int.test.ts
│   │   ├── dynamodb.int.test.ts
│   │   ├── appconfig.int.test.ts
│   │   ├── lambda.int.test.ts
│   │   ├── step-functions.int.test.ts
│   │   ├── eventbridge.int.test.ts
│   │   ├── waf.int.test.ts
│   │   ├── ecr.int.test.ts
│   │   └── organizations.int.test.ts
│   └── functional/                  # Functional tests (destructive, manual)
│       ├── .env.functional.example
│       ├── helpers.ts
│       ├── setup.func.test.ts
│       ├── sandbox.func.test.ts       # Provisions EC2 + populated S3 per region
│       ├── teardown.func.test.ts
│       └── verify-deletion.func.test.ts  # Admin-cred check that cleanup removed them
├── cdk.json
├── package.json
└── tsconfig.json
```

## Integration Tests

Unit tests (`npm test`) only verify the synthesised CloudFormation. Real
post-deploy validation happens in `test/integration/`, which uses the AWS SDK
to assert on the _deployed_ infrastructure.

### Running integration tests locally

```bash
# Authenticate against the hub account.
aws sts get-caller-identity

# Point the suite at the right deployment.
export ISB_HUB_REGION=us-west-2
export ISB_NAMESPACE=dev          # matches NAMESPACE used during deploy
export ISB_ORG_MGT_ACCOUNT=<org-management-account-id>

npm run test:integration
```

### Running them in the pipeline

The pipeline's `IntegrationTest-<Stage>` step does this automatically. It
assumes `InnovationSandboxIntegrationTestRole` in both the hub account and
the org management account. Pre-create the role in **each** account (see
step 5 above).

### What the included tests cover

| File                         | What it asserts                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudformation.int.test.ts` | All four upstream stacks reached `CREATE_COMPLETE` / `UPDATE_COMPLETE` and publish at least one Output.                                                                                                                |
| `api-gateway.int.test.ts`    | Compute-stack API URL is HTTPS, rejects unauthenticated requests with 401/403, and serves CORS preflight.                                                                                                              |
| `web-ui.int.test.ts`         | CloudFront distribution is `Deployed` and the root URL returns a 200 with the SPA shell HTML.                                                                                                                          |
| `dynamodb.int.test.ts`       | Each table referenced by Data-stack outputs is `ACTIVE`.                                                                                                                                                               |
| `appconfig.int.test.ts`      | An InnovationSandbox AppConfig application exists and its latest deployment per environment is in a healthy state.                                                                                                     |
| `lambda.int.test.ts`         | Every Lambda referenced by Compute-stack outputs is `Active` and not on a deprecated runtime.                                                                                                                          |
| `step-functions.int.test.ts` | The cleanup state machine is `ACTIVE` and the last 20 executions don't have a 100% failure rate.                                                                                                                       |
| `eventbridge.int.test.ts`    | A custom InnovationSandbox event bus exists, has at least one ENABLED rule, and every enabled rule has at least one target.                                                                                            |
| `waf.int.test.ts`            | A regional WAF web ACL exists, has at least one rule, and is associated with at least one API Gateway stage.                                                                                                           |
| `ecr.int.test.ts`            | (Skipped unless `ISB_PRIVATE_ECR_REPO` is set) The private AWS Nuke ECR repository exists and the latest image has a SHA-256 digest.                                                                                   |
| `organizations.int.test.ts`  | (Skipped unless `ISB_RUN_ORG_TESTS=true` and credentials reach the Org Management account) Sandbox OUs exist, at least one InnovationSandbox SCP exists, and every InnovationSandbox OU has at least one SCP attached. |

### Writing new integration tests

1. Create `test/integration/<feature>.int.test.ts`.
2. At the top of the file:
   ```ts
   import { loadIntegrationEnv } from "./support/test-env";
   jest.setTimeout(120_000);
   const env = loadIntegrationEnv();
   ```
3. Use the AWS SDK v3 clients to query deployed resources. Get resource IDs
   via `requireStackOutput(env.hubRegion, env.stackNames.compute, 'OutputKey')`
   instead of hardcoding them.
4. Prefer assertions about _current state_ over modifying state. Tests should
   be idempotent and safe to run on Prod.
5. Run `npm run test:integration` against your dev environment to confirm
   they pass before merging.

## Functional Tests

End-to-end tests that create leases, provision real resources in the sandbox
account, terminate the lease, and then confirm the account cleanup removed
everything. They are **destructive** (mutate live state) and run manually in
four stages with human action between each.

### Setup

```bash
cp test/functional/.env.functional.example test/functional/.env.functional
```

Fill in the following values:

| Variable                                 | Where to get it                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ISB_API_URL`                            | `https://<your-cloudfront-or-domain>/api`                                                                                                                                |
| `ISB_API_TOKEN`                          | Browser → DevTools → Application → Session Storage → `isb-jwt`                                                                                                           |
| `ISB_LEASE_TEMPLATE_ID`                  | Create one in the ISB UI, or leave blank (setup stage creates one)                                                                                                       |
| `AWS_ACCESS_KEY_ID` / `SECRET` / `TOKEN` | Admin credentials already authorized in the sandbox account, or credentials able to assume the sandbox account role; used for teardown cleanup and deletion verification |
| `ISB_HUB_REGION`                         | Region where ISB is deployed (e.g. `us-west-2`)                                                                                                                          |
| `ISB_NAMESPACE`                          | Namespace used during deploy (e.g. `myisb`, `prod`)                                                                                                                      |
| `ISB_SANDBOX_REGIONS`                    | Comma-separated supported regions to provision into and verify. Mirror your deployment's `AWS_REGIONS`. Defaults to `ISB_HUB_REGION`.                                    |
| `ISB_TEST_INSTANCE_TYPE`                 | Optional. Smallest instance type to launch (default `t3.nano`).                                                                                                          |
| `ISB_ADMIN_AWS_*`                        | Admin credentials for teardown cleanup and the verify stage. Falls back to `AWS_*`.                                                                                      |
| `ISB_ADMIN_ASSUME_ROLE_NAME`             | Optional. Role assumed in the sandbox account to clean/verify resources (default `OrganizationAccountAccessRole`).                                                       |

### Running

```bash
# Stage 1: Create a lease template and lease an account
npm run test:functional -- --testPathPattern=setup

# → Log into the sandbox account via the SSO portal
# → Copy credentials into .env.functional:
#   ISB_SANDBOX_AWS_ACCESS_KEY_ID=...
#   ISB_SANDBOX_AWS_SECRET_ACCESS_KEY=...
#   ISB_SANDBOX_AWS_SESSION_TOKEN=...

# Stage 2: Provision resources in every supported region.
# Creates a default VPC only when the region has none, then launches the
# smallest EC2 instance and creates an S3 bucket with an empty .txt object.
# Every resource is recorded immediately; failed regions clean partial work.
npm run test:functional -- --testPathPattern=sandbox

# Stage 3: Terminate the lease and wait for account cleanup. The stage checks
# that Nuke removed every recorded and unrecorded dummy resource, reports an
# error if anything remains, and then performs best-effort safety cleanup.
# Admin credentials are required for the check and safety cleanup.
npm run test:functional -- --testPathPattern=teardown

# Stage 4: Optional standalone repeat of the same Nuke cleanup enforcement.
# Useful after a failed teardown or for an independent audit.
npm run test:functional -- --testPathPattern=verify-deletion
```

The sandbox stage records each VPC, bucket, and instance as soon as it is
created in `test/functional/.functional-state.json`. If provisioning fails,
it attempts immediate cleanup with the sandbox credentials and preserves any
uncleaned records for the teardown retry. Stage 3 checks both the recorded
resources and the scoped `isb-func-test-<account>-<region>-` bucket prefix plus
the `isb:functional-test=true` EC2 tag, so older interrupted runs are included.
If Nuke left anything, Stage 3 fails even when its safety cleanup succeeds;
this makes a Nuke failure visible while still clearing the dummy resources.
State is preserved for the optional Stage 4 audit; remove the file after
verification if desired.

> Stage 3 and Stage 4 use admin credentials (`ISB_ADMIN_AWS_*`, or the fallback
> `AWS_*`) to authenticate into a non-leased account and inspect or safely clear
> resources after the sandbox lease ends.

> A test-created default VPC is only deleted as safety cleanup after Stage 3
> detects that Nuke left it. A pre-existing default VPC is never deleted. AWS
> Organizations SCPs must still allow the test's `ec2:CreateDefaultVpc`,
> `ec2:RunInstances`, and `s3:CreateBucket` actions.

> **Note:** The JWT expires after 60 minutes. If a stage takes too long, refresh
> the JWT in `.env.functional` before running the next stage.

## Customisation

### Change which accounts a stage targets

Edit the relevant `<STAGE>_ORG_MGT_ACCOUNT` / `_IDC_ACCOUNT` / `_HUB_ACCOUNT`
variables in your `.env`. For a single-account install, set all three to the
same value.

### Add or remove stages

A stage (Dev/Staging/Prod) is enabled only when all three of its `*_ACCOUNT`
variables are set. Leaving any of them blank disables that stage. To add a
fully custom stage beyond Dev/Staging/Prod, edit `lib/config/pipeline-config.ts`
and extend the `readStage` loop.

### Skip Docker image build

Default. Set `BUILD_AND_PUSH_NUKE_IMAGE=true` in `.env` to opt in to building
and pushing a private AWS Nuke ECR image into each Hub account.

### Inject extra environment variables

The upstream solution reads variables from `.env` (see upstream's
`.env.example`). To pass values into `cdk deploy`, extend the `envOverrides`
block inside `readStage()` in `lib/config/pipeline-config.ts`:

```ts
envOverrides: {
  NAMESPACE: optionalEnv(`${prefix}_NAMESPACE`, stageName.toLowerCase())!,
  IDENTITY_STORE_ID: requireEnv(`${prefix}_IDENTITY_STORE_ID`),
  SSO_INSTANCE_ARN: requireEnv(`${prefix}_SSO_INSTANCE_ARN`),
}
```

## Cost

A self-mutating CDK Pipeline using CodePipeline V2 + CodeBuild typically costs
\$1–\$5/month for low-frequency builds, plus the underlying solution costs.
See AWS documentation for [CodePipeline pricing](https://aws.amazon.com/codepipeline/pricing/)
and [CodeBuild pricing](https://aws.amazon.com/codebuild/pricing/).

## Troubleshooting

- **`Need to perform AWS calls for account X but no credentials configured`** —
  The target account is not bootstrapped or the trust relationship is missing.
  Re-run `cdk bootstrap aws://<account>/<region> --trust <tooling-account>`.
- **`Cannot find module 'aws-cdk-lib'`** — Run `npm install`.
- **Config change did nothing** — Check the `<pipeline>-config-change`
  EventBridge rule in the tooling account: its `Invocations`/`FailedInvocations`
  metrics tell you whether the SSM event arrived. `npm run config:push`
  skips the write when the value is unchanged, so run it with `FORCE=1` if you
  need a new parameter version.
- **A manual approval was rejected without anyone touching it** — Check the
  rejection comment. If it starts with "Automatically rejected", the approval
  unblocker freed the stage lock because a newer execution was queued behind it;
  approve that newer execution instead. Otherwise the approval hit the
  seven-day CodePipeline timeout, which cannot be extended — start a fresh run
  (push a commit, re-save the config parameter with `FORCE=1`, or _Release
  change_).
- **New executions sit at "Inbound" and never start** — An older execution is
  holding the stage lock. If it is parked on an approval, answer it or let the
  unblocker handle it; check the `<pipeline>-unblock-approval` rule's
  `Invocations` metric and the Lambda's logs to see what it decided.
- **`isb-config-<Stage>.env is missing from the synth artifact`** — The synth
  step ran before the config parameter existed. Run `npm run config:push`
  and start a new execution.
- **The approval's diff link 404s or shows "Access Denied"** — The `Diff-<Stage>`
  step failed before uploading, or you lack `kms:Decrypt` on the pipeline
  artifact key. The full diff is also printed in the `Diff-<Stage>` CodeBuild
  log, which is the fallback.
- **The diff says it could not assume the deploy role** — The same
  `InnovationSandboxPipelineDeployRole` used for deploys is used for the diff.
  See setup step 3.
- **Self-mutation loop / pipeline keeps replacing itself** — A change in the
  `cdk.context.json` snapshot. Commit the file to source control to stabilise.

# Collaboration

Thanks for your interest in our solution. Having specific examples of replication and usage allows us to continue to grow and scale our work. If you clone or use this repository, kindly shoot us a quick email to let us know you are interested in this work!

<wwps-cic@amazon.com>

# Disclaimers

**Customers are responsible for making their own independent assessment of the information in this document.**

**This document:**

Customers are responsible for making their own independent assessment of the information in this document.

This document:

(a) is for informational purposes only,

(b) references AWS product offerings and practices, which are subject to change without notice,

(c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided "as is" without warranties, representations, or conditions of any kind, whether express or implied. The responsibilities and liabilities of AWS to its customers are controlled by AWS agreements, and this document is not part of, nor does it modify, any agreement between AWS and its customers, and

(d) is not to be considered a recommendation or viewpoint of AWS.

Additionally, you are solely responsible for testing, security and optimizing all code and assets on GitHub repo, and all such code and assets should be considered:

(a) as-is and without warranties or representations of any kind,

(b) not suitable for production environments, or on production or other critical data, and

(c) to include shortcuts in order to support rapid prototyping such as, but not limited to, relaxed authentication and authorization and a lack of strict adherence to security best practices.

All work produced is open source. More information can be found in the GitHub repo.
