# Innovation Sandbox on AWS — CDK Deployment Pipeline

A self-mutating AWS CDK Pipeline that builds, tests, and deploys the [Innovation
Sandbox on AWS](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws/)
solution across multiple AWS accounts and stages (Dev / Staging / Prod).

## Prerequisites

- Node 22+ and npm 10+
- AWS CDK 2.167+ (`npm install -g aws-cdk`)
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

### 4. Create a CodeStar Connection to GitHub

In the tooling account, go to **Developer Tools → Settings → Connections** and
create a connection to your GitHub org. Copy the ARN.

### 5. Configure your pipeline

All pipeline configuration is read from environment variables (or a `.env`
file at the repository root). Copy the template and fill in your values:

```bash
cp .env.example .env
# then edit .env with your account IDs, CodeStar connection ARN, etc.
```

The most important variables:

| Variable | Required | Description |
|---|---|---|
| `TOOLING_ACCOUNT` | yes | 12-digit account where the pipeline runs |
| `TOOLING_REGION` | no | Defaults to `us-east-1` |
| `CODESTAR_CONNECTION_ARN` | yes | ARN from step 4 |
| `DEV_ORG_MGT_ACCOUNT`, `DEV_IDC_ACCOUNT`, `DEV_HUB_ACCOUNT` | one stage required | Account IDs for the Dev wave |
| `STAGING_*` / `PROD_*` | optional | Same shape as Dev; omit any stage you don't need |
| `BUILD_AND_PUSH_NUKE_IMAGE` | no | `true` to push a private AWS Nuke ECR image |
| `NOTIFICATION_EMAILS` | no | Comma-separated emails for pipeline failures |

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

After the first deploy, the pipeline becomes self-mutating. Push changes to
either this repo (pipeline definition) or the upstream Innovation Sandbox repo
to trigger a new run.

## Dual-Source Architecture

The pipeline uses **two GitHub source inputs**:

1. **This pipeline repo** (primary) — contains the CDK pipeline definition,
   integration tests, and configuration. Used for self-mutation and test steps.
2. **Upstream Innovation Sandbox repo** — contains the solution source code,
   CDK stacks, and Dockerfiles. Used for build/test/deploy steps.

Both sources trigger the pipeline on push. The CodeStar Connection must have
access to both repositories. Configure them via:

| Variable | Description |
|---|---|
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | Upstream Innovation Sandbox repo |
| `PIPELINE_GITHUB_OWNER` / `PIPELINE_GITHUB_REPO` / `PIPELINE_GITHUB_BRANCH` | This pipeline repo |

## Project Layout

```
.
├── bin/
│   └── pipeline-app.ts              # CDK app entrypoint
├── lib/
│   ├── pipeline-stack.ts            # Main pipeline stack
│   ├── config/
│   │   ├── environment-config.ts    # TypeScript types
│   │   └── pipeline-config.ts       # Default config
│   ├── stages/
│   │   └── innovation-sandbox-wave.ts  # Per-stage wave assembly
│   └── steps/
│       ├── deploy-step.ts           # Reusable per-stack deploy step
│       ├── nuke-image-step.ts       # AWS Nuke ECR build/push
│       └── integration-test-step.ts # Post-deploy smoke tests
├── test/
│   ├── pipeline-stack.test.ts       # Unit tests (no AWS calls)
│   └── integration/                 # Integration tests (real AWS calls)
│       ├── support/test-env.ts
│       ├── cloudformation.int.test.ts
│       ├── api-gateway.int.test.ts
│       ├── web-ui.int.test.ts
│       ├── dynamodb.int.test.ts
│       └── appconfig.int.test.ts
├── cdk.json
├── package.json
└── tsconfig.json
```

## Integration Tests

Unit tests (`npm test`) only verify the synthesised CloudFormation. Real
post-deploy validation happens in `test/integration/`, which uses the AWS SDK
to assert on the *deployed* infrastructure.

### Running integration tests locally

```bash
# Authenticate against the hub account.
aws sts get-caller-identity

# Point the suite at the right deployment.
export ISB_HUB_REGION=us-east-1
export ISB_NAMESPACE=dev          # matches NAMESPACE used during deploy

npm run test:integration
```

### Running them in the pipeline

The pipeline's `IntegrationTest-<Stage>` step does this automatically. It
assumes a role named `InnovationSandboxIntegrationTestRole` in the hub
account. Pre-create that role with:

- A trust policy allowing the tooling account
- Read-only policies for: cloudformation, apigateway, cloudfront, dynamodb,
  appconfig, ecr, lambda, sts

### What the included tests cover

| File | What it asserts |
|---|---|
| `cloudformation.int.test.ts` | All four upstream stacks reached `CREATE_COMPLETE` / `UPDATE_COMPLETE` and publish at least one Output. |
| `api-gateway.int.test.ts` | Compute-stack API URL is HTTPS, rejects unauthenticated requests with 401/403, and serves CORS preflight. |
| `web-ui.int.test.ts` | CloudFront distribution is `Deployed` and the root URL returns a 200 with the SPA shell HTML. |
| `dynamodb.int.test.ts` | Each table referenced by Data-stack outputs is `ACTIVE`. |
| `appconfig.int.test.ts` | An InnovationSandbox AppConfig application exists and its latest deployment per environment is in a healthy state. |
| `lambda.int.test.ts` | Every Lambda referenced by Compute-stack outputs is `Active` and not on a deprecated runtime. |
| `step-functions.int.test.ts` | The cleanup state machine is `ACTIVE` and the last 20 executions don't have a 100% failure rate. |
| `eventbridge.int.test.ts` | A custom InnovationSandbox event bus exists, has at least one ENABLED rule, and every enabled rule has at least one target. |
| `waf.int.test.ts` | A regional WAF web ACL exists, has at least one rule, and is associated with at least one API Gateway stage. |
| `ecr.int.test.ts` | (Skipped unless `ISB_PRIVATE_ECR_REPO` is set) The private AWS Nuke ECR repository exists and the latest image has a SHA-256 digest. |
| `organizations.int.test.ts` | (Skipped unless `ISB_RUN_ORG_TESTS=true` and credentials reach the Org Management account) Sandbox OUs exist, at least one InnovationSandbox SCP exists, and every InnovationSandbox OU has at least one SCP attached. |

### Writing new integration tests

1. Create `test/integration/<feature>.int.test.ts`.
2. At the top of the file:
   ```ts
   import { loadIntegrationEnv } from './support/test-env';
   jest.setTimeout(120_000);
   const env = loadIntegrationEnv();
   ```
3. Use the AWS SDK v3 clients to query deployed resources. Get resource IDs
   via `requireStackOutput(env.hubRegion, env.stackNames.compute, 'OutputKey')`
   instead of hardcoding them.
4. Prefer assertions about *current state* over modifying state. Tests should
   be idempotent and safe to run on Prod.
5. Run `npm run test:integration` against your dev environment to confirm
   they pass before merging.

For destructive or end-to-end functional tests (creating leases, exercising
the cleanup workflow), put them in a separate `test/functional/` directory and
gate them behind a `RUN_FUNCTIONAL_TESTS=true` env var so they don't run on
Prod by default.

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
- **Self-mutation loop / pipeline keeps replacing itself** — A change in the
  `cdk.context.json` snapshot. Commit the file to source control to stabilise.
