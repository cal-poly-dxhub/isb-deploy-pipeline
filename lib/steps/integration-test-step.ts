import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep, CodePipelineSource, IFileSetProducer } from 'aws-cdk-lib/pipelines';

import { CONFIG_INPUT_DIR, stageConfigPath } from '../config/stage-config-file';

export interface IntegrationTestStepProps {
  readonly stageName: string;
  /** The pipeline repo source (has package.json, test files, package-lock.json). */
  readonly input: CodePipelineSource;
  /**
   * The synth output, mounted as an additional input so the step can read the
   * namespace from the stage config file at runtime rather than having it
   * baked into the pipeline definition.
   */
  readonly configFileSet: IFileSetProducer;
  readonly hubAccount: string;
  readonly hubRegion: string;
  /** Org Management account ID. */
  readonly orgMgtAccount: string;
  /** Org Management region (for AWS Organizations tests). Defaults to hub. */
  readonly orgMgtRegion?: string;
  /**
   * Private ECR repository name. If set, the ECR integration test runs;
   * otherwise the test is skipped.
   */
  readonly privateEcrRepo?: string;
}

/**
 * Runs the integration test suite (`npm run test:integration`) against the
 * freshly deployed Innovation Sandbox installation in the hub account.
 *
 * The test suite lives in `test/integration/` of THIS pipeline repo. It uses
 * the AWS SDK to assert on the deployed CloudFormation, API Gateway,
 * CloudFront, DynamoDB, and AppConfig resources.
 *
 * The CodeBuild project assumes the `InnovationSandboxIntegrationTestRole` in
 * the hub account, which must:
 *
 *   - Trust the tooling account (or this pipeline's CodeBuild role)
 *   - Have read-only access to: cloudformation, apigateway, cloudfront,
 *     dynamodb, appconfig, ecr, lambda
 *
 * Failure of any test fails the pipeline stage.
 */
export function createIntegrationTestStep(
  props: IntegrationTestStepProps,
): CodeBuildStep {
  const orgMgtAccount = props.orgMgtAccount;
  const sameAccount = orgMgtAccount === props.hubAccount;

  // When hub and org mgmt are different accounts, assume the org mgmt role
  // FIRST (from the CodeBuild role, which has permission) and stash its
  // credentials as env vars for the test code. Then assume the hub role as
  // the default credentials.
  const orgMgtRoleCommands = sameAccount
    ? []
    : [
        `ORG_CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${orgMgtAccount}:role/InnovationSandboxIntegrationTestRole --role-session-name pipeline-integ-org --duration-seconds 3600)`,
        'export ISB_ORG_MGT_AWS_ACCESS_KEY_ID=$(echo $ORG_CREDS | jq -r .Credentials.AccessKeyId)',
        'export ISB_ORG_MGT_AWS_SECRET_ACCESS_KEY=$(echo $ORG_CREDS | jq -r .Credentials.SecretAccessKey)',
        'export ISB_ORG_MGT_AWS_SESSION_TOKEN=$(echo $ORG_CREDS | jq -r .Credentials.SessionToken)',
      ];

  const configPath = stageConfigPath(props.stageName);

  return new CodeBuildStep(`IntegrationTest-${props.stageName}`, {
    input: props.input,
    additionalInputs: {
      [CONFIG_INPUT_DIR]: props.configFileSet,
    },
    commands: [
      'set -eu',
      'echo "==> Running integration tests against ' + props.stageName + '"',
      // NAMESPACE comes from the synth artifact so that changing it does not
      // rewrite this project and force a pipeline self-mutation.
      `if [ ! -f "${configPath}" ]; then echo "ERROR: ${configPath} is missing from the synth artifact." >&2; exit 1; fi`,
      `set -a && . "${configPath}" && set +a`,
      'export ISB_NAMESPACE="${NAMESPACE:?NAMESPACE missing from the stage config file}"',
      'echo "==> ISB_NAMESPACE=$ISB_NAMESPACE"',
      // Assume org mgmt role first (while we still have CodeBuild role creds).
      ...orgMgtRoleCommands,
      // Then assume hub role as default credentials.
      `CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${props.hubAccount}:role/InnovationSandboxIntegrationTestRole --role-session-name pipeline-integ-test --duration-seconds 3600)`,
      'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
      'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
      'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
      'npm ci --no-audit --no-fund',
      'npm run test:integration',
    ],
    env: {
      ISB_HUB_REGION: props.hubRegion,
      ISB_ORG_MGT_ACCOUNT: orgMgtAccount,
      ...(props.orgMgtRegion ? { ISB_ORG_MGT_REGION: props.orgMgtRegion } : {}),
      ...(props.privateEcrRepo
        ? { ISB_PRIVATE_ECR_REPO: props.privateEcrRepo }
        : {}),
    },
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      computeType: codebuild.ComputeType.SMALL,
    },
    timeout: Duration.minutes(15),
    rolePolicyStatements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${props.hubAccount}:role/InnovationSandboxIntegrationTestRole`,
          ...(sameAccount
            ? []
            : [`arn:aws:iam::${orgMgtAccount}:role/InnovationSandboxIntegrationTestRole`]),
        ],
      }),
    ],
  });
}
