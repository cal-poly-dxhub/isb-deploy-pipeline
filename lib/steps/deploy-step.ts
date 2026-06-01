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

  const step = new CodeBuildStep(`Deploy-${props.stageName}-${props.stack}`, {
    input: props.input,
    commands: [
      // CodeBuild's default Linux shell is dash (Ubuntu's /bin/sh), which
      // does not support `set -o pipefail`. We use `set -eu` instead, which
      // is portable across dash, sh, and bash.
      'set -eu',
      'echo "==> Deploying upstream stack: ' + props.stack + '"',
      'echo "==> Target: ' + props.targetAccount + ' / ' + props.targetRegion + '"',
      'node --version',
      'npm --version',
      'npm ci --no-audit --no-fund',
      // The upstream CDK code reads CDK_DEFAULT_ACCOUNT/REGION via env. We
      // have already set them above. We pass --require-approval never to
      // avoid blocking on IAM change prompts.
      `npx cdk deploy --app cdk.out --require-approval never --concurrency 4 InnovationSandbox-${capitalize(props.stack)} || npm run ${stackToScript[props.stack]} -- --require-approval never`,
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
