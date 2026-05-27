# Innovation Sandbox on AWS — CDK Deployment Pipeline

A self-mutating AWS CDK Pipeline that builds, tests, and deploys the [Innovation
Sandbox on AWS](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws/)
solution across multiple AWS accounts and stages (Dev / Staging / Prod).

## Architecture

```
                  ┌────────────────────────────────────┐
                  │         Tooling Account            │
                  │  ┌──────────────────────────────┐  │
                  │  │  CodePipeline (this stack)   │  │
                  │  └──────────────┬───────────────┘  │
                  │                 │                  │
                  └─────────────────┼──────────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
        ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
        │  Dev Wave    │ -> │ Staging Wave │ -> │  Prod Wave   │
        └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
               │                   │                   │
       ┌───────┼───────────────────┼───────────────────┼───────┐
       ▼       ▼                   ▼                   ▼       ▼
   AccountPool  IDC               Data         Nuke ECR Image  Compute
    (Org Mgmt) (IDC)             (Hub)             (Hub)        (Hub)
```

Each wave deploys the four Innovation Sandbox stacks in dependency order:

1. **AccountPool** → Org Management account (creates OUs, SCPs)
2. **IDC** → IAM Identity Center delegated admin account (permission sets)
3. **Data** → Hub account (DynamoDB, AppConfig)
4. **(Optional) Nuke ECR Image** → Hub account (private AWS Nuke Docker image)
5. **Compute** → Hub account (CloudFront, API Gateway, Lambda, Step Functions)
6. **(Optional) Integration Tests** → Hub account

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

### 3. (Optional) Pre-create the AWS Nuke ECR push role in each Hub account

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
│   └── pipeline-stack.test.ts
├── cdk.json
├── package.json
└── tsconfig.json
```

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
