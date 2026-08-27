import { CodePipelineSource, ManualApprovalStep, Wave } from 'aws-cdk-lib/pipelines';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import { DeploymentStageConfig } from '../config/environment-config';
import { createDeployStep } from '../steps/deploy-step';
import { createDiffStep, stageDiffUrl } from '../steps/diff-step';
import { createIntegrationTestStep } from '../steps/integration-test-step';
import { createNukeImageBuildStep } from '../steps/nuke-image-step';
import { IFileSetProducer } from 'aws-cdk-lib/pipelines';

export interface InnovationSandboxWaveProps {
  /** Wave that this stage attaches its steps into. */
  readonly wave: Wave;

  /** Configuration for this stage (Dev/Staging/Prod). */
  readonly stage: DeploymentStageConfig;

  /** The synth output (pipeline repo) used by integration test steps. */
  readonly input: IFileSetProducer;

  /** The upstream Innovation Sandbox source used by deploy/nuke steps. */
  readonly upstreamSource: CodePipelineSource;

  /** The pipeline repo source (for integration tests). */
  readonly pipelineSource: CodePipelineSource;

  /** If true, build & push the AWS Nuke Docker image before Compute deploy. */
  readonly buildAndPushNukeImage: boolean;

  /** The tooling account ID (where the pipeline runs). */
  readonly toolingAccount: string;

  /** Scope used to create stage-scoped SNS topics for approval notifications. */
  readonly scope: Construct;

  /** Bucket the pre-approval `cdk diff` is published to. */
  readonly diffBucketName: string;

  /** ARN of that bucket. */
  readonly diffBucketArn: string;

  /** ARN of the KMS key the bucket is encrypted with. */
  readonly diffKeyArn: string;

  /** Region the pipeline (and diff bucket) live in. */
  readonly toolingRegion: string;

  /**
   * If true, the pre-approval `cdk diff` runs with `-v`, surfacing why a
   * read-only change set could not be created. Off by default; see
   * PipelineConfig.diffVerbose.
   */
  readonly diffVerbose?: boolean;
}

/**
 * Adds the four-stack Innovation Sandbox deployment to a pipeline Wave with
 * proper ordering:
 *
 *   AccountPool (org mgmt)
 *      └── IDC (idc account)
 *             └── Data (hub account)
 *                    └── [optional] Build & push Nuke ECR image
 *                           └── Compute (hub account)
 *                                  └── [optional] Integration tests
 *
 * If `requireManualApproval` is set on the stage, a ManualApprovalStep is
 * inserted at the *start* of the wave (i.e. before AccountPool deploys).
 */
export function addInnovationSandboxDeployment(
  props: InnovationSandboxWaveProps,
): void {
  const { wave, stage, input, upstreamSource, buildAndPushNukeImage, toolingAccount, pipelineSource, scope } = props;

  // 1. Optional manual approval gate at the front of the wave, preceded by a
  //    `cdk diff` so the reviewer can see exactly what they are authorising.
  let approvalStep: ManualApprovalStep | undefined;
  if (stage.requireManualApproval) {
    const diffStep = createDiffStep({
      stageName: stage.stageName,
      input: upstreamSource,
      pipelineSource,
      configFileSet: input,
      targets: [
        {
          stack: 'InnovationSandbox-AccountPool',
          account: stage.accounts.orgManagement.account,
          region: stage.accounts.orgManagement.region,
        },
        {
          stack: 'InnovationSandbox-IDC',
          account: stage.accounts.idc.account,
          region: stage.accounts.idc.region,
        },
        {
          stack: 'InnovationSandbox-Data',
          account: stage.accounts.hub.account,
          region: stage.accounts.hub.region,
        },
        {
          stack: 'InnovationSandbox-Compute',
          account: stage.accounts.hub.account,
          region: stage.accounts.hub.region,
        },
      ],
      diffBucketName: props.diffBucketName,
      diffBucketArn: props.diffBucketArn,
      diffKeyArn: props.diffKeyArn,
      region: props.toolingRegion,
      toolingAccount,
      diffVerbose: props.diffVerbose,
    });
    wave.addPre(diffStep);

    createApprovalTopic(scope, stage); // surfaces an SNS topic for ops
    const diffUrl = stageDiffUrl(
      stage.stageName,
      props.diffBucketName,
      props.toolingRegion,
    );
    approvalStep = new ManualApprovalStep(`Approve-${stage.stageName}`, {
      comment:
        `Approve deployment to ${stage.stageName}. Review the diff before ` +
        `approving: ${diffUrl}`,
    });
    // The diff must be published before the approval starts waiting.
    approvalStep.addStepDependency(diffStep);
    wave.addPre(approvalStep);
  }

  // 2. Account Pool stack -> Org Management account.
  const accountPoolStep = createDeployStep({
    stack: 'account-pool',
    stageName: stage.stageName,
    input: upstreamSource,
    configFileSet: input,
    toolingAccount,
    targetAccount: stage.accounts.orgManagement.account,
    targetRegion: stage.accounts.orgManagement.region,
  });
  // The approval must complete before AccountPool starts.
  if (approvalStep) {
    accountPoolStep.addStepDependency(approvalStep);
  }

  // 3. IDC stack -> IDC delegated admin account.
  const idcStep = createDeployStep({
    stack: 'idc',
    stageName: stage.stageName,
    input: upstreamSource,
    configFileSet: input,
    toolingAccount,
    targetAccount: stage.accounts.idc.account,
    targetRegion: stage.accounts.idc.region,
    dependsOn: [accountPoolStep],
  });

  // 4. Data stack -> Hub account.
  const dataStep = createDeployStep({
    stack: 'data',
    stageName: stage.stageName,
    input: upstreamSource,
    configFileSet: input,
    toolingAccount,
    targetAccount: stage.accounts.hub.account,
    targetRegion: stage.accounts.hub.region,
    dependsOn: [idcStep],
  });

  // 5. Optional Nuke Docker image build/push between Data and Compute.
  // Per-stage config (NAMESPACE, account IDs, upstream passthrough vars) is NOT
  // passed here - each deploy step sources it from the synth artifact at
  // runtime. Only genuinely structural values belong in `staticEnv`.
  let postDataDependency = dataStep;
  const computeStaticEnv: Record<string, string> = {};

  if (buildAndPushNukeImage) {
    const nukeStep = createNukeImageBuildStep({
      stageName: stage.stageName,
      input: upstreamSource,
      hubAccount: stage.accounts.hub.account,
      hubRegion: stage.accounts.hub.region,
      ecrRepoName: `innovation-sandbox-${stage.stageName.toLowerCase()}`,
    });
    nukeStep.addStepDependency(dataStep);
    postDataDependency = nukeStep;

    computeStaticEnv.PRIVATE_ECR_REPO = `innovation-sandbox-${stage.stageName.toLowerCase()}`;
    computeStaticEnv.PRIVATE_ECR_REPO_REGION = stage.accounts.hub.region;

    wave.addPost(nukeStep);
  }

  // 6. Compute stack -> Hub account.
  const computeStep = createDeployStep({
    stack: 'compute',
    stageName: stage.stageName,
    input: upstreamSource,
    configFileSet: input,
    toolingAccount,
    targetAccount: stage.accounts.hub.account,
    targetRegion: stage.accounts.hub.region,
    staticEnv: computeStaticEnv,
    dependsOn: [postDataDependency],
  });

  // 7. Optional integration tests.
  if (stage.runIntegrationTests) {
    const testStep = createIntegrationTestStep({
      stageName: stage.stageName,
      input: pipelineSource,
      configFileSet: input,
      hubAccount: stage.accounts.hub.account,
      hubRegion: stage.accounts.hub.region,
      orgMgtAccount: stage.accounts.orgManagement.account,
      orgMgtRegion: stage.accounts.orgManagement.region,
      privateEcrRepo: buildAndPushNukeImage
        ? `innovation-sandbox-${stage.stageName.toLowerCase()}`
        : undefined,
    });
    testStep.addStepDependency(computeStep);
    wave.addPost(testStep);
  }

  // Attach all primary deploy steps to the wave so they execute in dependency
  // order. Wave.addPost is the public API for "do this in the wave".
  wave.addPost(accountPoolStep, idcStep, dataStep, computeStep);
}

/**
 * Creates an SNS topic for approval notifications, subscribing each configured
 * email. Returns undefined if no email recipients are configured.
 */
function createApprovalTopic(
  scope: Construct,
  stage: DeploymentStageConfig,
): Topic | undefined {
  const emails = stage.approvalNotificationEmails ?? [];
  if (emails.length === 0) {
    return undefined;
  }
  const topic = new Topic(scope, `ApprovalTopic-${stage.stageName}`, {
    displayName: `Innovation Sandbox ${stage.stageName} approvals`,
  });
  for (const email of emails) {
    topic.addSubscription(new EmailSubscription(email));
  }
  return topic;
}
