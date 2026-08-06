import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  CodeBuildStep,
  CodePipelineSource,
  IFileSetProducer,
} from 'aws-cdk-lib/pipelines';

import { CONFIG_INPUT_DIR, stageConfigPath } from '../config/stage-config-file';

/** Where the pipeline repo is mounted so its scripts/ directory is reachable. */
const PIPELINE_REPO_INPUT_DIR = '../pipeline-repo';

/** S3 key prefix under which rendered diffs are published. */
export function stageDiffKey(stageName: string): string {
  return `diffs/${stageName}/latest.txt`;
}

/**
 * Console URL a reviewer opens from the manual approval to read the diff.
 *
 * A fixed `latest.txt` per stage is unambiguous: CodePipeline locks a stage
 * while it holds an execution, so only one execution can ever be sitting at a
 * given stage's approval at a time.
 */
export function stageDiffUrl(
  stageName: string,
  bucketName: string,
  region: string,
): string {
  const key = encodeURIComponent(stageDiffKey(stageName));
  return `https://s3.console.aws.amazon.com/s3/object/${bucketName}?region=${region}&prefix=${key}`;
}

export interface DiffStepProps {
  /** Pipeline stage name (e.g. "Dev"). */
  readonly stageName: string;

  /** The upstream Innovation Sandbox source (provides the CDK app). */
  readonly input: IFileSetProducer;

  /** The pipeline repo source, mounted for `scripts/render_stage_diff.sh`. */
  readonly pipelineSource: CodePipelineSource;

  /** The synth output, mounted for the per-stage config file. */
  readonly configFileSet: IFileSetProducer;

  /** Stacks to diff, in deploy order, with the account/region each targets. */
  readonly targets: ReadonlyArray<{
    readonly stack: string;
    readonly account: string;
    readonly region: string;
  }>;

  /** Bucket the rendered diff is published to. */
  readonly diffBucketName: string;

  /** ARN of the bucket, for the PutObject grant. */
  readonly diffBucketArn: string;

  /** ARN of the KMS key the bucket is encrypted with. */
  readonly diffKeyArn: string;

  /** Region the bucket lives in. */
  readonly region: string;

  /** Tooling account; targets here are diffed without assuming a role. */
  readonly toolingAccount: string;
}

/**
 * Renders `cdk diff` for every upstream stack in a stage and publishes it to
 * S3, so the manual approval that follows can link straight to it.
 *
 * This runs before the approval in the same pipeline stage. It is informational
 * and never fails the stage: `render_stage_diff.sh` records per-stack problems
 * in the output rather than aborting, so an unrenderable diff cannot block a
 * deployment.
 */
export function createDiffStep(props: DiffStepProps): CodeBuildStep {
  const configPath = stageConfigPath(props.stageName);
  const diffKey = stageDiffKey(props.stageName);
  const targetArgs = props.targets
    .map((t) => `${t.stack}:${t.account}:${t.region}`)
    .join(' ');

  const assumableRoles = Array.from(
    new Set(
      props.targets
        .map((t) => t.account)
        .filter((account) => account !== props.toolingAccount),
    ),
  ).map(
    (account) =>
      `arn:aws:iam::${account}:role/InnovationSandboxPipelineDeployRole`,
  );

  return new CodeBuildStep(`Diff-${props.stageName}`, {
    input: props.input,
    additionalInputs: {
      [CONFIG_INPUT_DIR]: props.configFileSet,
      [PIPELINE_REPO_INPUT_DIR]: props.pipelineSource,
    },
    commands: [
      'set -eu',
      `echo "==> Rendering cdk diff for ${props.stageName}"`,
      `if [ ! -f "${configPath}" ]; then echo "ERROR: ${configPath} is missing from the synth artifact." >&2; exit 1; fi`,
      `set -a && . "${configPath}" && set +a`,
      'npm ci --no-audit --no-fund',
      `TOOLING_ACCOUNT=${props.toolingAccount} bash ${PIPELINE_REPO_INPUT_DIR}/scripts/render_stage_diff.sh /tmp/isb-diff.txt ${targetArgs}`,
      // Surface it in the build log too, so the diff survives even if the
      // upload fails.
      'cat /tmp/isb-diff.txt',
      `aws s3 cp /tmp/isb-diff.txt "s3://${props.diffBucketName}/${diffKey}" --content-type text/plain --sse aws:kms --sse-kms-key-id "${props.diffKeyArn}" --region ${props.region}`,
      `echo "==> Diff published to ${stageDiffUrl(props.stageName, props.diffBucketName, props.region)}"`,
    ],
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      computeType: codebuild.ComputeType.MEDIUM,
    },
    timeout: Duration.minutes(30),
    rolePolicyStatements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: assumableRoles,
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [`${props.diffBucketArn}/diffs/*`],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [props.diffKeyArn],
      }),
    ],
  });
}
