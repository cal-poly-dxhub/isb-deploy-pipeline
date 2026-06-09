import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep, IFileSetProducer } from 'aws-cdk-lib/pipelines';

/**
 * Logical identifier for one of the four upstream stacks. The values match the
 * upstream `npm run deploy:<value>` scripts.
 */
export type UpstreamStack = 'account-pool' | 'idc' | 'data' | 'compute';

export interface DeployStepProps {
  /** The upstream stack this step is responsible for. */
  readonly stack: UpstreamStack;

  /** Pipeline stage name (e.g. "Dev"). Used only for naming. */
  readonly stageName: string;

  /** Output of the synth/build step that produced the cloud assembly. */
  readonly input: IFileSetProducer;

  /** AWS account that the stack is deployed into. */
  readonly targetAccount: string;

  /** AWS region that the stack is deployed into. */
  readonly targetRegion: string;

  /**
   * Environment variables to inject into the CodeBuild project. These are
   * forwarded to the upstream `cdk deploy` invocation and may include the
   * variables documented in the upstream `.env.example` (e.g. NAMESPACE,
   * HUB_ACCOUNT_ID, ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, IDENTITY_STORE_ID,
   * SSO_INSTANCE_ARN, etc.).
   */
  readonly envOverrides?: Record<string, string>;

  /**
   * Steps that must complete successfully before this step runs. Used to
   * enforce the AccountPool -> IDC -> Data -> Compute ordering.
   */
  readonly dependsOn?: CodeBuildStep[];
}

/**
 * Creates a CodeBuildStep that deploys a single upstream Innovation Sandbox
 * stack into a specific target account/region.
 *
 * The step:
 *   1. Restores the upstream source/build artifact produced by the synth step.
 *   2. Re-installs only what is required to run `cdk deploy` (npm ci).
 *   3. Assumes the CDK deployment role in the target account (granted via the
 *      target's `cdk bootstrap --trust <tooling-account>`).
 *   4. Runs `npm run deploy:<stack>` from the upstream package.json with
 *      `--require-approval never` to allow non-interactive deploys.
 *
 * The CodeBuild project's role is granted permission to assume any
 * `cdk-*-deploy-role-*` and `cdk-*-file-publishing-role-*` in the target
 * accounts, which CDK's bootstrap roles match by default.
 */
export function createDeployStep(props: DeployStepProps): CodeBuildStep {
  const stackToScript: Record<UpstreamStack, string> = {
    'account-pool': 'deploy:account-pool',
    idc: 'deploy:idc',
    data: 'deploy:data',
    compute: 'deploy:compute',
  };

  const envOverrides = props.envOverrides ?? {};
  const buildEnvVars: Record<string, string> = {
    CDK_DEFAULT_ACCOUNT: props.targetAccount,
    CDK_DEFAULT_REGION: props.targetRegion,
    AWS_REGION: props.targetRegion,
    ...envOverrides,
  };

  // Convert plain strings into BuildEnvironmentVariable objects.
  const buildEnvironmentVariables: Record<
    string,
    codebuild.BuildEnvironmentVariable
  > = Object.fromEntries(
    Object.entries(buildEnvVars).map(([key, value]) => [
      key,
      { value, type: codebuild.BuildEnvironmentVariableType.PLAINTEXT },
    ]),
  );

  const stackToCfnName: Record<UpstreamStack, string> = {
    'account-pool': 'InnovationSandbox-AccountPool',
    idc: 'InnovationSandbox-IDC',
    data: 'InnovationSandbox-Data',
    compute: 'InnovationSandbox-Compute',
  };

  // Per-stack CloudFormation parameters and context flags (matching upstream deploy scripts)
  const stackDeployCmd: Record<UpstreamStack, string> = {
    'account-pool': 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-AccountPool --require-approval=never --parameters ParentOuId=$PARENT_OU_ID --parameters HubAccountId=$HUB_ACCOUNT_ID --context deploymentMode=${DEPLOYMENT_MODE:-STANDARD} --parameters IsbManagedRegions=$AWS_REGIONS',
    idc: 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-IDC --require-approval=never --parameters IdentityStoreId=$IDENTITY_STORE_ID --parameters SsoInstanceArn=$SSO_INSTANCE_ARN --parameters OrgMgtAccountId=$ORG_MGT_ACCOUNT_ID --parameters HubAccountId=$HUB_ACCOUNT_ID --parameters AdminGroupName=${ADMIN_GROUP_NAME:-InnovationSandboxAdmins} --parameters ManagerGroupName=${MANAGER_GROUP_NAME:-InnovationSandboxManagers} --parameters UserGroupName=${USER_GROUP_NAME:-InnovationSandboxUsers}',
    data: 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-Data --require-approval=never --context deploymentMode=${DEPLOYMENT_MODE:-STANDARD} --context nukeConfigFilePath=${NUKE_CONFIG_FILE_PATH:-}',
    compute: 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-Compute --require-approval=never --parameters OrgMgtAccountId=$ORG_MGT_ACCOUNT_ID --parameters IdcAccountId=$IDC_ACCOUNT_ID --parameters AcceptSolutionTermsOfUse=${ACCEPT_SOLUTION_TERMS_OF_USE:-Accept} --context deploymentMode=${DEPLOYMENT_MODE:-STANDARD} --context privateEcrRepo=${PRIVATE_ECR_REPO:-}',
  };

  // Only assume a cross-account role if deploying to a different account than
  // the tooling account (where CodeBuild runs). For same-account deploys,
  // the CodeBuild role already has sufficient permissions.
  const assumeRoleCommands = props.targetAccount !== (process.env.TOOLING_ACCOUNT ?? props.targetAccount)
    ? [
        `CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${props.targetAccount}:role/InnovationSandboxPipelineDeployRole --role-session-name cdk-deploy)`,
        'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
        'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
        'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
      ]
    : [];

  const step = new CodeBuildStep(`Deploy-${props.stageName}-${props.stack}`, {
    input: props.input,
    commands: [
      'set -eu',
      'echo "==> Deploying upstream stack: ' + props.stack + '"',
      'echo "==> Target: ' + props.targetAccount + ' / ' + props.targetRegion + '"',
      'node --version',
      'npm --version',
      ...assumeRoleCommands,
      'npm ci --no-audit --no-fund',
      'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk synth',
      stackDeployCmd[props.stack],
    ],
    env: buildEnvVars,
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      computeType: codebuild.ComputeType.MEDIUM,
      privileged: false,
      environmentVariables: buildEnvironmentVariables,
    },
    timeout: Duration.minutes(240),
    rolePolicyStatements: [
      // Allow CodeBuild to assume the CDK bootstrap roles in the target
      // account. CDK bootstrap creates roles with predictable name patterns.
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${props.targetAccount}:role/cdk-*-deploy-role-*`,
          `arn:aws:iam::${props.targetAccount}:role/cdk-*-file-publishing-role-*`,
          `arn:aws:iam::${props.targetAccount}:role/cdk-*-image-publishing-role-*`,
          `arn:aws:iam::${props.targetAccount}:role/cdk-*-lookup-role-*`,
          `arn:aws:iam::${props.targetAccount}:role/cdk-*-cfn-exec-role-*`,
          `arn:aws:iam::${props.targetAccount}:role/OrganizationAccountAccessRole`,
          `arn:aws:iam::${props.targetAccount}:role/InnovationSandboxPipelineDeployRole`,
        ],
      }),
    ],
  });

  if (props.dependsOn?.length) {
    for (const dep of props.dependsOn) {
      step.addStepDependency(dep);
    }
  }

  return step;
}

function capitalize(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
