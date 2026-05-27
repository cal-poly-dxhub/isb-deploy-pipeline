import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep, IFileSetProducer } from 'aws-cdk-lib/pipelines';

export interface IntegrationTestStepProps {
  readonly stageName: string;
  readonly input: IFileSetProducer;
  readonly hubAccount: string;
  readonly hubRegion: string;
}

/**
 * Runs post-deployment smoke tests against the freshly deployed Innovation
 * Sandbox installation. Examples of useful checks:
 *
 *   - Verify CloudFormation stack outputs include the expected web UI URL.
 *   - Hit the API Gateway health endpoint and assert 401 without auth (sanity).
 *   - Verify the AWS Nuke ECR image is present (when private repo is enabled).
 *   - Verify the AppConfig hosted configuration version resolves successfully.
 *
 * The actual test logic should live in the upstream repo (e.g. a future
 * `npm run test:integration` script). This step is a thin runner that assumes
 * a read-only role in the hub account and executes those tests.
 */
export function createIntegrationTestStep(
  props: IntegrationTestStepProps,
): CodeBuildStep {
  return new CodeBuildStep(`IntegrationTest-${props.stageName}`, {
    input: props.input,
    commands: [
      'set -euo pipefail',
      'echo "==> Running integration tests against ' + props.stageName + '"',
      `CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${props.hubAccount}:role/InnovationSandboxIntegrationTestRole --role-session-name pipeline-integ-test)`,
      'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
      'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
      'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
      'npm ci --no-audit --no-fund',
      // The upstream repo does not currently expose a separate integration
      // test script, so we run the unit/snapshot tests as a baseline guard
      // and log the deployed stack outputs for manual inspection.
      'npm test -- --reporter=default',
      `aws cloudformation describe-stacks --region ${props.hubRegion} --stack-name InnovationSandbox-Compute --query "Stacks[0].Outputs" --output table || true`,
    ],
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      computeType: codebuild.ComputeType.SMALL,
    },
    timeout: Duration.minutes(60),
    rolePolicyStatements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${props.hubAccount}:role/InnovationSandboxIntegrationTestRole`,
        ],
      }),
    ],
  });
}
