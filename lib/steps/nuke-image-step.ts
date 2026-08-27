import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep, IFileSetProducer } from 'aws-cdk-lib/pipelines';

export interface NukeImageBuildStepProps {
  readonly stageName: string;
  readonly input: IFileSetProducer;
  readonly hubAccount: string;
  readonly hubRegion: string;
  /** ECR repository name (e.g. "innovation-sandbox"). */
  readonly ecrRepoName: string;
}

/**
 * Builds the AWS Nuke Docker image used by the Compute stack's CodeBuild
 * cleanup project and pushes it to a private ECR repository in the hub
 * account.
 *
 * The upstream solution uses AWS Nuke to delete user-created resources during
 * account recycling. The Dockerfile lives at:
 *   `source/infrastructure/components/account-cleaner/Dockerfile`
 *
 * Per the upstream README, when the env vars `PRIVATE_ECR_REPO` and
 * `PRIVATE_ECR_REPO_REGION` are set, the Compute stack uses the private repo
 * instead of the public AWS image. This step makes that wiring deterministic.
 */
export function createNukeImageBuildStep(
  props: NukeImageBuildStepProps,
): CodeBuildStep {
  const ecrUri = `${props.hubAccount}.dkr.ecr.${props.hubRegion}.amazonaws.com/${props.ecrRepoName}`;

  return new CodeBuildStep(`BuildNukeImage-${props.stageName}`, {
    input: props.input,
    commands: [
      'set -eu',
      'echo "==> Building AWS Nuke image for ' + props.stageName + '"',
      // Assume the ECR push role in the hub account.
      `CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${props.hubAccount}:role/InnovationSandboxEcrPushRole --role-session-name pipeline-ecr-push)`,
      'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
      'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
      'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
      `aws ecr get-login-password --region ${props.hubRegion} | docker login --username AWS --password-stdin ${ecrUri}`,
      // Idempotent: create repo if missing (will silently fail if it exists).
      `aws ecr describe-repositories --repository-names ${props.ecrRepoName} --region ${props.hubRegion} || aws ecr create-repository --repository-name ${props.ecrRepoName} --region ${props.hubRegion} --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256`,
      'docker build -t ' +
        ecrUri +
        ':latest -f source/infrastructure/components/account-cleaner/Dockerfile source/infrastructure/components/account-cleaner',
      `docker tag ${ecrUri}:latest ${ecrUri}:$CODEBUILD_RESOLVED_SOURCE_VERSION`,
      `docker push ${ecrUri}:latest`,
      `docker push ${ecrUri}:$CODEBUILD_RESOLVED_SOURCE_VERSION`,
    ],
    env: {
      PRIVATE_ECR_REPO: props.ecrRepoName,
      PRIVATE_ECR_REPO_REGION: props.hubRegion,
    },
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      computeType: codebuild.ComputeType.MEDIUM,
      privileged: true, // required for `docker build`
    },
    timeout: Duration.minutes(90),
    rolePolicyStatements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${props.hubAccount}:role/InnovationSandboxEcrPushRole`,
        ],
      }),
    ],
  });
}
