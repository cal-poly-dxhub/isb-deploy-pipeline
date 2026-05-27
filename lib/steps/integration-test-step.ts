import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep, IFileSetProducer } from 'aws-cdk-lib/pipelines';

export interface IntegrationTestStepProps {
  readonly stageName: string;
  readonly input: IFileSetProducer;
  readonly hubAccount: string;
  readonly hubRegion: string;
  /** Namespace passed via ISB_NAMESPACE so test stack lookups resolve. */
  readonly namespace: string;
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
  return new CodeBuildStep(`IntegrationTest-${props.stageName}`, {
    input: props.input,
    commands: [
      'set -euo pipefail',
      'echo "==> Running integration tests against ' + props.stageName + '"',
      `CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${props.hubAccount}:role/InnovationSandboxIntegrationTestRole --role-session-name pipeline-integ-test --duration-seconds 3600)`,
      'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
      'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
      'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
      // Install dev dependencies (jest, ts-jest, AWS SDK clients).
      'npm ci --no-audit --no-fund',
      // Run the integration project. --runInBand serialises tests so we
      // don't burn API quota with parallel describe-stack calls.
      'npm run test:integration',
    ],
    env: {
      ISB_HUB_REGION: props.hubRegion,
      ISB_NAMESPACE: props.namespace,
    },
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
