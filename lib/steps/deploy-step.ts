import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep, IFileSetProducer } from 'aws-cdk-lib/pipelines';

import { CONFIG_INPUT_DIR, stageConfigPath } from '../config/stage-config-file';

/**
 * Logical identifier for one of the four upstream stacks. The values match the
 * upstream `npm run deploy:<value>` scripts.
 */
export type UpstreamStack = 'account-pool' | 'idc' | 'data' | 'compute';

export interface DeployStepProps {
  /** The upstream stack this step is responsible for. */
  readonly stack: UpstreamStack;

  /** Pipeline stage name (e.g. "Dev"). Selects the stage config file. */
  readonly stageName: string;

  /** Output of the synth/build step that produced the cloud assembly. */
  readonly input: IFileSetProducer;

  /**
   * The synth output, mounted as an additional input so the step can source
   * `isb-config-<stage>.env` at runtime.
   */
  readonly configFileSet: IFileSetProducer;

  /** AWS account that the stack is deployed into. */
  readonly targetAccount: string;

  /** AWS region that the stack is deployed into. */
  readonly targetRegion: string;

  /** The tooling account where the pipeline runs. Used to determine if cross-account role assumption is needed. */
  readonly toolingAccount: string;

  /**
   * Environment variables baked into the CodeBuild project.
   *
   * Reserve this for values that are already structural (i.e. that change the
   * pipeline definition anyway, such as the private ECR repo which only exists
   * when the nuke image step is enabled). Ordinary per-stage configuration must
   * NOT go here - it belongs in the stage config file so that changing it does
   * not force a self-mutation. See lib/config/stage-config-file.ts.
   */
  readonly staticEnv?: Record<string, string>;

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

  const envOverrides = props.staticEnv ?? {};
  const buildEnvVars: Record<string, string> = {
    CDK_DEFAULT_ACCOUNT: props.targetAccount,
    CDK_DEFAULT_REGION: props.targetRegion,
    AWS_REGION: props.targetRegion,
    DEPLOY_REGION: props.targetRegion,
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

  // Per-stack CloudFormation parameters and context flags. These mirror
  // upstream v1.3+ scripts/cdk/deploy.sh, with two additions documented by
  // the official upgrade guide: AdditionalPrincipalExceptions and
  // BedrockInferenceProfilePatterns. Keep this mapping in sync with
  // scripts/render_stage_diff.sh so approval diffs use the same parameters.
  const stackDeployCmd: Record<UpstreamStack, string> = {
    'account-pool': 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-AccountPool "$@" --require-approval=never --parameters Namespace=${NAMESPACE:?NAMESPACE is required} --parameters ParentOuId=${PARENT_OU_ID:?PARENT_OU_ID is required} --parameters HubAccountId=${HUB_ACCOUNT_ID:?HUB_ACCOUNT_ID is required} --parameters IsbManagedRegions=${AWS_REGIONS:?AWS_REGIONS is required} ${ADDITIONAL_ALLOWED_SERVICES:+--parameters AdditionalAllowedServices=$ADDITIONAL_ALLOWED_SERVICES} ${ADDITIONAL_PRINCIPAL_EXCEPTIONS:+--parameters AdditionalPrincipalExceptions=$ADDITIONAL_PRINCIPAL_EXCEPTIONS} ${BEDROCK_INFERENCE_PROFILE_PATTERNS:+--parameters BedrockInferenceProfilePatterns=$BEDROCK_INFERENCE_PROFILE_PATTERNS}',
    idc: 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-IDC "$@" --require-approval=never --parameters Namespace=${NAMESPACE:?NAMESPACE is required} --parameters IdentityStoreId=${IDENTITY_STORE_ID:?IDENTITY_STORE_ID is required} --parameters SsoInstanceArn=${SSO_INSTANCE_ARN:?SSO_INSTANCE_ARN is required} --parameters OrgMgtAccountId=${ORG_MGT_ACCOUNT_ID:?ORG_MGT_ACCOUNT_ID is required} --parameters HubAccountId=${HUB_ACCOUNT_ID:?HUB_ACCOUNT_ID is required} ${ADMIN_GROUP_NAME:+--parameters AdminGroupName=$ADMIN_GROUP_NAME} ${MANAGER_GROUP_NAME:+--parameters ManagerGroupName=$MANAGER_GROUP_NAME} ${USER_GROUP_NAME:+--parameters UserGroupName=$USER_GROUP_NAME}',
    data: 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-Data "$@" --require-approval=never --parameters Namespace=${NAMESPACE:?NAMESPACE is required} --parameters SamlMetadataUrl=${SAML_METADATA_URL:?SAML_METADATA_URL is required for v1.3.0} --parameters AwsAccessPortalUrl=${AWS_ACCESS_PORTAL_URL:?AWS_ACCESS_PORTAL_URL is required for v1.3.0}',
    compute: 'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- deploy InnovationSandbox-Compute "$@" --require-approval=never --parameters Namespace=${NAMESPACE:?NAMESPACE is required} --parameters OrgMgtAccountId=${ORG_MGT_ACCOUNT_ID:?ORG_MGT_ACCOUNT_ID is required} --parameters IdcAccountId=${IDC_ACCOUNT_ID:?IDC_ACCOUNT_ID is required} --parameters AcceptSolutionTermsOfUse=${ACCEPT_SOLUTION_TERMS_OF_USE:-Accept} ${CUSTOM_DOMAIN_NAME:+--parameters CustomDomainName=$CUSTOM_DOMAIN_NAME} ${CUSTOM_DOMAIN_CERTIFICATE_ARN:+--parameters CustomDomainCertificateArn=$CUSTOM_DOMAIN_CERTIFICATE_ARN} ${ALLOW_LISTED_IP_RANGES:+--parameters AllowListedIPRanges=$ALLOW_LISTED_IP_RANGES} ${USE_STABLE_TAGGING:+--parameters UseStableTagging=$USE_STABLE_TAGGING}',
  };

  // Only assume a cross-account role if deploying to a different account than
  // the tooling account (where CodeBuild runs). For same-account deploys,
  // the CodeBuild role already has sufficient permissions.
  const deployTimeoutMinutes = 120;
  const assumeRoleDurationSeconds = 3600; // Capped at role's MaxSessionDuration
  const assumeRoleCommands = props.targetAccount !== props.toolingAccount
    ? [
        `CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${props.targetAccount}:role/InnovationSandboxPipelineDeployRole --role-session-name cdk-deploy --duration-seconds ${assumeRoleDurationSeconds})`,
        'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
        'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
        'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
      ]
    : [];

  const configPath = stageConfigPath(props.stageName);

  const step = new CodeBuildStep(`Deploy-${props.stageName}-${props.stack}`, {
    input: props.input,
    additionalInputs: {
      [CONFIG_INPUT_DIR]: props.configFileSet,
    },
    commands: [
      'set -eu',
      'echo "==> Deploying upstream stack: ' + props.stack + '"',
      'echo "==> Target: ' + props.targetAccount + ' / ' + props.targetRegion + '"',
      'node --version',
      'npm --version',
      // Per-stage config is read from the synth artifact at runtime, not baked
      // into this project's environment. A config-only change therefore does
      // not alter the pipeline definition.
      `if [ ! -f "${configPath}" ]; then echo "ERROR: ${configPath} is missing from the synth artifact. Run 'npm run config:push' so the config parameter exists, then re-run the pipeline." >&2; exit 1; fi`,
      `echo "==> Loading stage config from ${configPath}"`,
      `set -a && . "${configPath}" && set +a`,
      'echo "==> NAMESPACE=${NAMESPACE:-<unset>} ORG_MGT_ACCOUNT_ID=${ORG_MGT_ACCOUNT_ID:-<unset>} IDC_ACCOUNT_ID=${IDC_ACCOUNT_ID:-<unset>} HUB_ACCOUNT_ID=${HUB_ACCOUNT_ID:-<unset>}"',
      ...assumeRoleCommands,
      'npm ci --no-audit --no-fund',
      // Build the same optional context list as upstream v1.3.0 deploy.sh.
      // CodeBuild runs commands with /bin/sh, so use POSIX positional
      // parameters rather than Bash arrays. Quoting "$@" preserves each
      // context key/value as one argument.
      'set -- --context "deploymentMode=${DEPLOYMENT_MODE:-prod}"',
      'if [ -n "${LOG_LEVEL:-}" ]; then set -- "$@" --context "logLevel=$LOG_LEVEL"; fi',
      'if [ -n "${CLOUDWATCH_LOG_RETENTION_IN_DAYS:-}" ]; then set -- "$@" --context "cloudWatchLogRetentionInDays=$CLOUDWATCH_LOG_RETENTION_IN_DAYS"; fi',
      'if [ -n "${S3_LOGS_ARCHIVE_RETENTION_IN_DAYS:-}" ]; then set -- "$@" --context "s3LogsArchiveRetentionInDays=$S3_LOGS_ARCHIVE_RETENTION_IN_DAYS"; fi',
      'if [ -n "${S3_LOGS_GLACIER_RETENTION_IN_DAYS:-}" ]; then set -- "$@" --context "s3LogsGlacierRetentionInDays=$S3_LOGS_GLACIER_RETENTION_IN_DAYS"; fi',
      'if [ -n "${API_THROTTLING_RATE_LIMIT:-}" ]; then set -- "$@" --context "apiThrottlingRateLimit=$API_THROTTLING_RATE_LIMIT"; fi',
      'if [ -n "${API_THROTTLING_BURST_LIMIT:-}" ]; then set -- "$@" --context "apiThrottlingBurstLimit=$API_THROTTLING_BURST_LIMIT"; fi',
      'if [ -n "${COGNITO_ACCESS_TOKEN_VALIDITY_MINUTES:-}" ]; then set -- "$@" --context "cognitoAccessTokenValidityMinutes=$COGNITO_ACCESS_TOKEN_VALIDITY_MINUTES"; fi',
      'if [ -n "${COGNITO_ID_TOKEN_VALIDITY_MINUTES:-}" ]; then set -- "$@" --context "cognitoIdTokenValidityMinutes=$COGNITO_ID_TOKEN_VALIDITY_MINUTES"; fi',
      'if [ -n "${COGNITO_REFRESH_TOKEN_VALIDITY_DAYS:-}" ]; then set -- "$@" --context "cognitoRefreshTokenValidityDays=$COGNITO_REFRESH_TOKEN_VALIDITY_DAYS"; fi',
      'if [ -n "${NUKE_CONFIG_FILE_PATH:-}" ]; then set -- "$@" --context "nukeConfigFilePath=$NUKE_CONFIG_FILE_PATH"; fi',
      'if [ -n "${SCP_DIRECTORY_PATH:-}" ]; then set -- "$@" --context "scpDirectoryPath=$SCP_DIRECTORY_PATH"; fi',
      'if [ -n "${PRIVATE_ECR_REPO:-}" ]; then set -- "$@" --context "privateEcrRepo=$PRIVATE_ECR_REPO"; fi',
      'npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- synth "$@"',
      stackDeployCmd[props.stack],
    ],
    env: buildEnvVars,
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      computeType: codebuild.ComputeType.MEDIUM,
      privileged: false,
      environmentVariables: buildEnvironmentVariables,
    },
    timeout: Duration.minutes(deployTimeoutMinutes),
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
