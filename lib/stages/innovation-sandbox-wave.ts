import { ManualApprovalStep, Wave } from 'aws-cdk-lib/pipelines';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import { DeploymentStageConfig } from '../config/environment-config';
import { createDeployStep } from '../steps/deploy-step';
import { createIntegrationTestStep } from '../steps/integration-test-step';
import { createNukeImageBuildStep } from '../steps/nuke-image-step';
import { IFileSetProducer } from 'aws-cdk-lib/pipelines';

export interface InnovationSandboxWaveProps {
  /** Wave that this stage attaches its steps into. */
  readonly wave: Wave;

  /** Configuration for this stage (Dev/Staging/Prod). */
  readonly stage: DeploymentStageConfig;

  /** The synth output / source artifact used by deploy steps. */
  readonly input: IFileSetProducer;

  /** If true, build & push the AWS Nuke Docker image before Compute deploy. */
  readonly buildAndPushNukeImage: boolean;

  /** Scope used to create stage-scoped SNS topics for approval notifications. */
  readonly scope: Construct;
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
  const { wave, stage, input, buildAndPushNukeImage, scope } = props;

  // 1. Optional manual approval gate at the front of the wave.
  let approvalStep: ManualApprovalStep | undefined;
  if (stage.requireManualApproval) {
    createApprovalTopic(scope, stage); // surfaces an SNS topic for ops
    approvalStep = new ManualApprovalStep(`Approve-${stage.stageName}`, {
      comment: `Approve deployment to ${stage.stageName}. Review the synth diff before approving.`,
    });
    wave.addPre(approvalStep);
  }

  // 2. Account Pool stack -> Org Management account.
  const accountPoolStep = createDeployStep({
    stack: 'account-pool',
    stageName: stage.stageName,
    input,
    targetAccount: stage.accounts.orgManagement.account,
    targetRegion: stage.accounts.orgManagement.region,
    envOverrides: {
      ...stage.envOverrides,
      ORG_MGT_ACCOUNT_ID: stage.accounts.orgManagement.account,
      IDC_ACCOUNT_ID: stage.accounts.idc.account,
      HUB_ACCOUNT_ID: stage.accounts.hub.account,
    },
  });
  // The approval must complete before AccountPool starts.
  if (approvalStep) {
    accountPoolStep.addStepDependency(approvalStep);
  }

  // 3. IDC stack -> IDC delegated admin account.
  const idcStep = createDeployStep({
    stack: 'idc',
    stageName: stage.stageName,
    input,
    targetAccount: stage.accounts.idc.account,
    targetRegion: stage.accounts.idc.region,
    envOverrides: {
      ...stage.envOverrides,
      ORG_MGT_ACCOUNT_ID: stage.accounts.orgManagement.account,
      IDC_ACCOUNT_ID: stage.accounts.idc.account,
      HUB_ACCOUNT_ID: stage.accounts.hub.account,
    },
    dependsOn: [accountPoolStep],
  });

  // 4. Data stack -> Hub account.
  const dataStep = createDeployStep({
    stack: 'data',
    stageName: stage.stageName,
    input,
    targetAccount: stage.accounts.hub.account,
    targetRegion: stage.accounts.hub.region,
    envOverrides: {
      ...stage.envOverrides,
      ORG_MGT_ACCOUNT_ID: stage.accounts.orgManagement.account,
      IDC_ACCOUNT_ID: stage.accounts.idc.account,
      HUB_ACCOUNT_ID: stage.accounts.hub.account,
    },
    dependsOn: [idcStep],
  });

  // 5. Optional Nuke Docker image build/push between Data and Compute.
  let postDataDependency = dataStep;
  const computeEnvOverrides: Record<string, string> = {
    ...stage.envOverrides,
    ORG_MGT_ACCOUNT_ID: stage.accounts.orgManagement.account,
    IDC_ACCOUNT_ID: stage.accounts.idc.account,
    HUB_ACCOUNT_ID: stage.accounts.hub.account,
  };

  if (buildAndPushNukeImage) {
    const nukeStep = createNukeImageBuildStep({
      stageName: stage.stageName,
      input,
      hubAccount: stage.accounts.hub.account,
      hubRegion: stage.accounts.hub.region,
      ecrRepoName: `innovation-sandbox-${stage.stageName.toLowerCase()}`,
    });
    nukeStep.addStepDependency(dataStep);
    postDataDependency = nukeStep;

    computeEnvOverrides.PRIVATE_ECR_REPO = `innovation-sandbox-${stage.stageName.toLowerCase()}`;
    computeEnvOverrides.PRIVATE_ECR_REPO_REGION = stage.accounts.hub.region;

    wave.addPost(nukeStep);
  }

  // 6. Compute stack -> Hub account.
  const computeStep = createDeployStep({
    stack: 'compute',
    stageName: stage.stageName,
    input,
    targetAccount: stage.accounts.hub.account,
    targetRegion: stage.accounts.hub.region,
    envOverrides: computeEnvOverrides,
    dependsOn: [postDataDependency],
  });

  // 7. Optional integration tests.
  if (stage.runIntegrationTests) {
    const testStep = createIntegrationTestStep({
      stageName: stage.stageName,
      input,
      hubAccount: stage.accounts.hub.account,
      hubRegion: stage.accounts.hub.region,
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
