import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  Wave,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import * as path from 'path';

import { PipelineConfig } from './config/environment-config';
import { addInnovationSandboxDeployment } from './stages/innovation-sandbox-wave';
import { stageDiffUrl } from './steps/diff-step';

/** Centralized version constants to prevent drift across pipeline steps. */
const NODEJS_VERSION = '22';
const CDK_CLI_VERSION = '2.167.1';

/** Default SSM parameter holding the pipeline configuration. */
const DEFAULT_CONFIG_PARAMETER_NAME = '/isb-pipeline/config';

/**
 * Explicit CodePipeline action names for the two source actions.
 *
 * These are pinned (rather than left to CDK's default of "<owner>_<repo>")
 * because the V2 `Triggers` block has to reference source actions by name. A
 * name derived from the repo would change whenever someone points the pipeline
 * at a fork, silently breaking push triggers.
 */
const PIPELINE_SOURCE_ACTION_NAME = 'PipelineRepoSource';
const UPSTREAM_SOURCE_ACTION_NAME = 'UpstreamRepoSource';

export interface PipelineStackProps extends StackProps {
  readonly config: PipelineConfig;
}

/**
 * Self-mutating CDK Pipeline that deploys the Innovation Sandbox on AWS
 * solution to one or more environments (Dev/Staging/Prod), each potentially
 * spanning multiple AWS accounts (Org Management, IDC, Hub).
 *
 * High-level flow:
 *
 *   1. Source            - Pulls upstream Innovation Sandbox source from
 *                          GitHub via CodeStar Connections.
 *
 *   2. Synth/Build       - Installs dependencies, runs lint, runs unit/
 *                          snapshot tests, builds the frontend, and runs
 *                          `cdk synth` to produce a cloud assembly. Also
 *                          runs `cdk synth` for THIS pipeline (self-mutate).
 *
 *   3. UpdatePipeline    - Auto-injected by CDK Pipelines. Applies any pipeline
 *                          changes detected in the synth output before
 *                          continuing with deploys.
 *
 *   4. Per-stage Wave    - For each configured stage, optionally a manual
 *                          approval, then deploys AccountPool -> IDC ->
 *                          Data -> [Nuke image] -> Compute -> [integ tests].
 *
 * Cross-account deployment relies on the standard CDK bootstrap pattern:
 * each target account must be bootstrapped to TRUST this pipeline's tooling
 * account.
 */
export class PipelineStack extends Stack {
  public readonly pipeline: CodePipeline;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { config } = props;

    Tags.of(this).add('Project', 'InnovationSandbox');
    Tags.of(this).add('Component', 'CICD');
    Tags.of(this).add('ManagedBy', 'CDK');
    // NOTE: there is deliberately no ConfigHash tag here. It used to be added
    // to force a self-mutation whenever the SSM config changed, but because
    // stack tags land on every taggable resource - including the pipeline
    // itself - it guaranteed a CloudFormation diff on every config edit. That
    // diff triggered self-mutation, which triggered RestartExecutionOnUpdate,
    // which produced a second execution for a single config change. Config is
    // now carried inside the synth artifact and read at deploy time instead
    // (see lib/config/stage-config-file.ts), so a config-only change produces
    // no pipeline diff at all.
    // ------------------------------------------------------------------
    // 1. Encryption + artifact bucket
    // ------------------------------------------------------------------
    // Use a customer-managed KMS key so cross-account roles can be granted
    // explicit decrypt permissions on pipeline artifacts. We use DESTROY for
    // the pipeline's own scratch resources so a failed initial deploy can be
    // retried without manual cleanup. (The upstream solution stacks - which
    // hold real data - use their own retention policies.)
    const artifactKey = new kms.Key(this, 'PipelineArtifactKey', {
      alias: `alias/${config.pipelineName.toLowerCase()}-artifacts`,
      description: 'KMS key for Innovation Sandbox pipeline artifacts',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const artifactBucket = new s3.Bucket(this, 'PipelineArtifactBucket', {
      bucketName: `${config.pipelineName.toLowerCase()}-artifacts-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: artifactKey,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // Grant every target account's CDK deploy role access to the artifact
    // bucket+key. CDK Pipelines normally does this automatically when using
    // CDK Pipeline-managed Stages. Because we use raw CodeBuildSteps that
    // exec `cdk deploy`, we explicitly grant access here.
    const allTargetAccounts = new Set<string>();
    for (const stage of config.stages) {
      allTargetAccounts.add(stage.accounts.orgManagement.account);
      allTargetAccounts.add(stage.accounts.idc.account);
      allTargetAccounts.add(stage.accounts.hub.account);
    }
    for (const accountId of allTargetAccounts) {
      artifactKey.grantDecrypt(new iam.AccountPrincipal(accountId));
      artifactBucket.grantRead(new iam.AccountPrincipal(accountId));
    }

    // ------------------------------------------------------------------
    // 2. Source actions
    // ------------------------------------------------------------------
    // PRIMARY source: this pipeline repo (required for self-mutation).
    const pipelineSource = CodePipelineSource.connection(
      `${config.pipelineSource.owner}/${config.pipelineSource.repo}`,
      config.pipelineSource.branch,
      {
        connectionArn: config.pipelineSource.codestarConnectionArn!,
        triggerOnPush: true,
        actionName: PIPELINE_SOURCE_ACTION_NAME,
      },
    );

    // ADDITIONAL source: upstream Innovation Sandbox repo.
    const upstreamSource = CodePipelineSource.connection(
      `${config.source.owner}/${config.source.repo}`,
      config.source.branch,
      {
        connectionArn: config.source.codestarConnectionArn!,
        triggerOnPush: true,
        actionName: UPSTREAM_SOURCE_ACTION_NAME,
      },
    );

    // ------------------------------------------------------------------
    // 3. Synth step (build + test + cdk synth for upstream + this pipeline)
    // ------------------------------------------------------------------
    // The pipeline repo is the PRIMARY input (so self-mutate finds
    // InnovationSandboxPipelineStack in the cloud assembly). The upstream
    // Innovation Sandbox repo is mounted as an additional input at
    // `../upstream`.
    const firstStage = config.stages[0];
    const configParameterName =
      config.configParameterName ?? DEFAULT_CONFIG_PARAMETER_NAME;
    const synthEnv: Record<string, string> = {
      NODE_OPTIONS: '--max-old-space-size=8192',
      // Upstream synth needs these unprefixed. These are only fallbacks for
      // the very first run (before the SSM parameter exists) - normally
      // load_ssm_config.sh overwrites them from the live config.
      ORG_MGT_ACCOUNT_ID: firstStage.accounts.orgManagement.account,
      IDC_ACCOUNT_ID: firstStage.accounts.idc.account,
      HUB_ACCOUNT_ID: firstStage.accounts.hub.account,
    };

    const synthStep = new CodeBuildStep('Synth', {
      input: pipelineSource,
      additionalInputs: {
        '../upstream': upstreamSource,
      },
      installCommands: [
        'set -eu',
        'echo "Node $(node --version), npm $(npm --version)"',
        `npm install -g aws-cdk@${CDK_CLI_VERSION}`,
      ],
      commands: [
        'set -eu',
        // Load config from SSM FIRST. Everything below - including the
        // upstream synth - then runs against the current configuration, so an
        // SSM change is picked up by this run rather than the next one.
        'cd "$CODEBUILD_SRC_DIR"',
        `bash ./scripts/load_ssm_config.sh "${configParameterName}" "${config.toolingEnv.region}" /tmp/isb.env`,
        'set -a && . /tmp/isb.env && set +a',
        'echo "Upstream synth targets: org=$ORG_MGT_ACCOUNT_ID idc=$IDC_ACCOUNT_ID hub=$HUB_ACCOUNT_ID"',
        // Build & test upstream
        'echo "==> Installing upstream dependencies"',
        'cd ../upstream && npm ci --no-audit --no-fund',
        'echo "==> Lint"',
        'cd ../upstream && npm run lint --if-present || true',
        'echo "==> Unit & snapshot tests"',
        'cd ../upstream && npm test',
        'echo "==> Synth upstream Innovation Sandbox CDK app"',
        'cd ../upstream/source/infrastructure && npx cdk synth --all --output ../../cdk.out',
        // Synth this pipeline
        'echo "==> Synth pipeline stack"',
        'cd "$CODEBUILD_SRC_DIR"',
        'npm ci --no-audit --no-fund',
        'npx cdk synth',
        // The per-stage config files written by bin/pipeline-app.ts must be in
        // the artifact for the deploy steps to source at runtime.
        'ls -1 cdk.out/isb-config-*.env',
        'echo "==> Done"',
      ],
      env: synthEnv,
      buildEnvironment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      partialBuildSpec: codebuild.BuildSpec.fromObject({
        phases: {
          install: {
            'runtime-versions': { nodejs: NODEJS_VERSION },
          },
        },
      }),
      timeout: Duration.minutes(30),
      primaryOutputDirectory: 'cdk.out',
    });

    // ------------------------------------------------------------------
    // 4. CodePipeline
    // ------------------------------------------------------------------
    const pipelineLogGroup = new logs.LogGroup(this, 'PipelineLogGroup', {
      logGroupName: `/aws/codepipeline/${config.pipelineName}`,
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: config.pipelineName,
      synth: synthStep,
      crossAccountKeys: true, // creates per-account KMS keys for artifact decrypt
      selfMutation: true,
      cliVersion: CDK_CLI_VERSION,
      dockerEnabledForSynth: true,
      dockerEnabledForSelfMutation: true,
      artifactBucket,
      // Use the explicit artifact bucket above; setting it here ensures the
      // bucket created by the construct does not become a duplicate.
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
          computeType: codebuild.ComputeType.MEDIUM,
        },
        // Force Node 22 for every CodeBuild project (deploy, self-mutate,
        // asset publishing, integration tests). Upstream Innovation Sandbox
        // dependencies (vite@7.x and friends) require Node 20.19+.
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: {
            install: {
              'runtime-versions': { nodejs: NODEJS_VERSION },
            },
          },
        }),
        rolePolicy: [
          // Allow lookups in CodeBuild for the upstream synth (e.g. SSM
          // parameter context lookups).
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'ssm:GetParameter',
              'ssm:GetParameters',
              'ssm:GetParametersByPath',
            ],
            resources: ['*'],
          }),
          // Cross-account CDK lookup roles.
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: ['arn:aws:iam::*:role/cdk-*'],
            conditions: {
              StringEquals: {
                'aws:ResourceTag/aws-cdk:bootstrap-role': [
                  'lookup',
                  'deploy',
                  'file-publishing',
                  'image-publishing',
                ],
              },
            },
          }),
        ],
        logging: {
          cloudWatch: {
            logGroup: pipelineLogGroup,
            prefix: 'codebuild',
          },
        },
        timeout: Duration.minutes(60),
      },
    });

    // ------------------------------------------------------------------
    // 5. Deployment waves (one per configured stage)
    // ------------------------------------------------------------------
    for (const stageConfig of config.stages) {
      const wave: Wave = this.pipeline.addWave(stageConfig.stageName);
      addInnovationSandboxDeployment({
        wave,
        stage: stageConfig,
        input: synthStep,
        upstreamSource,
        pipelineSource,
        buildAndPushNukeImage: config.buildAndPushNukeImage ?? false,
        toolingAccount: config.toolingEnv.account,
        toolingRegion: config.toolingEnv.region,
        diffBucketName: artifactBucket.bucketName,
        diffBucketArn: artifactBucket.bucketArn,
        diffKeyArn: artifactKey.keyArn,
        diffVerbose: config.diffVerbose ?? false,
        scope: this,
      });
    }

    // ------------------------------------------------------------------
    // 6. Pipeline-level overrides: execution mode + triggers
    // ------------------------------------------------------------------
    // buildPipeline() is required before the underlying CfnPipeline is
    // reachable. Everything past this point mutates the built pipeline, so no
    // further waves or stages may be added below.
    this.pipeline.buildPipeline();

    const cfnPipeline = this.pipeline.pipeline.node
      .defaultChild as codepipeline.CfnPipeline;
    cfnPipeline.addPropertyOverride('PipelineType', 'V2');
    // SUPERSEDED: a newer execution replaces an older one still waiting to
    // enter a stage, so the pipeline always converges on the newest source and
    // config instead of replaying stale revisions.
    cfnPipeline.addPropertyOverride('ExecutionMode', 'SUPERSEDED');

    // A V2 pipeline needs one trigger entry per source action it should react
    // to. Previously only the upstream source had one, and its action name was
    // discovered by substring-matching "aws-solutions" - which resolves to
    // `undefined` for any fork and leaves the pipeline with a broken trigger.
    // Both actions are now named explicitly and referenced by constant.
    assertSourceActionsExist(this.pipeline.pipeline, [
      PIPELINE_SOURCE_ACTION_NAME,
      UPSTREAM_SOURCE_ACTION_NAME,
    ]);
    cfnPipeline.addPropertyOverride('Triggers', [
      gitPushTrigger(PIPELINE_SOURCE_ACTION_NAME, config.pipelineSource.branch),
      gitPushTrigger(UPSTREAM_SOURCE_ACTION_NAME, config.source.branch),
    ]);

    // ------------------------------------------------------------------
    // 7. Start a run whenever the config parameter changes
    // ------------------------------------------------------------------
    // Config lives in SSM and is only read during Synth, so a config change on
    // its own used to leave the pipeline idle: nothing re-synthesised, nothing
    // re-baked the per-stage parameters, and the deployed stacks silently kept
    // the previous values. Reacting to the Parameter Store event (rather than
    // starting the run from the publish script) means edits made directly in the
    // console or by any other tooling are picked up too.
    if (config.triggerOnConfigChange ?? true) {
      new events.Rule(this, 'ConfigChangeTrigger', {
        ruleName: truncate(`${config.pipelineName}-config-change`, 64),
        description:
          `Starts ${config.pipelineName} when ${configParameterName} changes ` +
          'in SSM Parameter Store.',
        eventPattern: {
          source: ['aws.ssm'],
          detailType: ['Parameter Store Change'],
          detail: {
            name: parameterNameMatchers(configParameterName),
            operation: ['Create', 'Update', 'LabelParameterVersion'],
          },
        },
        targets: [
          new targets.CodePipeline(this.pipeline.pipeline, {
            retryAttempts: 2,
          }),
        ],
      });
    }

    const approvalActions = findApprovalActions(this.pipeline.pipeline);

    // Give each approval a clickable link to the diff rendered by the Diff step
    // that runs immediately before it. `ManualApprovalStep` only surfaces
    // `comment` (CustomData), so ExternalEntityLink - the field the console
    // renders as a link on the approval dialog - is set via an override.
    for (const approval of approvalActions) {
      cfnPipeline.addPropertyOverride(
        `Stages.${approval.stageIndex}.Actions.${approval.actionIndex}.Configuration.ExternalEntityLink`,
        stageDiffUrl(
          approval.stageName,
          artifactBucket.bucketName,
          config.toolingEnv.region,
        ),
      );
    }

    // ------------------------------------------------------------------
    // 8. Unblock stale manual approvals
    // ------------------------------------------------------------------
    // SUPERSEDED mode only supersedes executions *between* stages. An
    // execution parked on a manual approval sits *inside* a stage and holds its
    // lock, so newer executions stack up as inbound and never overtake it - the
    // stage stays locked until someone answers the approval or it times out
    // after seven days (a timeout AWS does not let you configure). This restores
    // the intended "newest wins" behaviour by rejecting the stale approval,
    // which releases the lock so the waiting execution can enter.
    if ((config.unblockStaleApprovals ?? true) && approvalActions.length > 0) {
      const unblocker = new lambda.Function(this, 'ApprovalUnblocker', {
        // Constructed by name rather than via lambda.Runtime.NODEJS_22_X
        // because the enum in aws-cdk-lib 2.167.1 stops at NODEJS_20_X. Kept on
        // 22 to match NODEJS_VERSION used by every CodeBuild project above.
        runtime: new lambda.Runtime(
          `nodejs${NODEJS_VERSION}.x`,
          lambda.RuntimeFamily.NODEJS,
        ),
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
          path.join(__dirname, 'lambda', 'approval-unblocker'),
        ),
        timeout: Duration.seconds(30),
        description:
          `Rejects a pending approval in ${config.pipelineName} when a newer ` +
          'execution is blocked behind it.',
        // Explicit log group rather than the legacy `logRetention` prop, which
        // provisions a custom resource to set retention after the fact.
        logGroup: new logs.LogGroup(this, 'ApprovalUnblockerLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        environment: {
          PIPELINE_NAME: config.pipelineName,
          APPROVAL_ACTIONS: JSON.stringify(
            approvalActions.map((a) => ({
              stageName: a.stageName,
              actionName: a.actionName,
            })),
          ),
        },
      });

      const pipelineArn = this.pipeline.pipeline.pipelineArn;
      unblocker.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'codepipeline:GetPipelineState',
            'codepipeline:ListPipelineExecutions',
          ],
          resources: [pipelineArn],
        }),
      );
      unblocker.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['codepipeline:PutApprovalResult'],
          // PutApprovalResult is authorised per approval action, whose ARN is
          // <pipeline-arn>/<stage>/<action>.
          resources: approvalActions.map(
            (a) => `${pipelineArn}/${a.stageName}/${a.actionName}`,
          ),
        }),
      );

      new events.Rule(this, 'ApprovalUnblockTrigger', {
        ruleName: truncate(`${config.pipelineName}-unblock-approval`, 64),
        description:
          'Re-evaluates pending approvals whenever an execution starts or ' +
          'clears a stage, so a stale approval cannot wedge the pipeline.',
        eventPattern: {
          source: ['aws.codepipeline'],
          detailType: [
            'CodePipeline Pipeline Execution State Change',
            'CodePipeline Stage Execution State Change',
          ],
          detail: {
            pipeline: [config.pipelineName],
            state: ['STARTED', 'SUCCEEDED'],
          },
        },
        targets: [new targets.LambdaFunction(unblocker, { retryAttempts: 2 })],
      });
    }

    // ------------------------------------------------------------------
    // 9. Notifications
    // ------------------------------------------------------------------
    if (
      config.notificationTopicArn === undefined &&
      config.notificationEmails &&
      config.notificationEmails.length > 0
    ) {
      const topic = new Topic(this, 'PipelineNotificationsTopic', {
        displayName: 'Innovation Sandbox pipeline notifications',
      });
      for (const email of config.notificationEmails) {
        topic.addSubscription(new EmailSubscription(email));
      }
      // We pass an explicit short name because CodeStar Notifications enforces
      // a 64-character limit on rule names and the CDK auto-generated name
      // (which prefixes the construct path) can exceed that.
      this.pipeline.pipeline.notifyOn('PipelineFailures', topic, {
        notificationRuleName: truncate(`${config.pipelineName}-failures`, 64),
        events: [
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_CANCELED,
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUPERSEDED,
          codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_NEEDED,
          // A pending approval is abandoned when a newer execution supersedes
          // it or the 7-day timeout expires. That leaves the pipeline idle
          // until something starts a new run, so it needs to be visible.
          codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_FAILED,
        ],
      });
    }
  }
}

/**
 * Builds a V2 pipeline git push trigger for a single source action.
 */
function gitPushTrigger(sourceActionName: string, branch: string) {
  return {
    ProviderType: 'CodeStarSourceConnection',
    GitConfiguration: {
      SourceActionName: sourceActionName,
      Push: [{ Branches: { Includes: [branch] } }],
    },
  };
}

/**
 * Fails synth if a trigger references a source action that does not exist.
 * A `Triggers` entry pointing at a missing action is accepted by
 * CloudFormation but never fires, which is exactly the silent-no-trigger
 * failure mode this guards against.
 */
function assertSourceActionsExist(
  pipeline: codepipeline.Pipeline,
  expected: string[],
): void {
  const actual = pipeline.stages[0].actions.map(
    (a) => a.actionProperties.actionName,
  );
  const missing = expected.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Expected source action(s) ${missing.join(', ')} in the Source stage, ` +
        `but found: ${actual.join(', ')}. Pipeline triggers would not fire.`,
    );
  }
}

/**
 * SSM `Parameter Store Change` events report `detail.name`; whether the
 * leading slash of a hierarchical name is included has varied, so match both
 * forms rather than risk a rule that never fires.
 */
function parameterNameMatchers(parameterName: string): string[] {
  const withoutSlash = parameterName.replace(/^\//, '');
  return withoutSlash === parameterName
    ? [parameterName]
    : [parameterName, withoutSlash];
}

/**
 * Locates every manual approval action in the built pipeline, with the stage
 * and action indices needed for CloudFormation property overrides. Read from
 * the pipeline itself rather than reconstructed from config so the names cannot
 * drift from what CodePipeline actually calls them.
 */
function findApprovalActions(pipeline: codepipeline.Pipeline): Array<{
  stageName: string;
  actionName: string;
  stageIndex: number;
  actionIndex: number;
}> {
  const found: Array<{
    stageName: string;
    actionName: string;
    stageIndex: number;
    actionIndex: number;
  }> = [];
  pipeline.stages.forEach((stage, stageIndex) => {
    stage.actions.forEach((action, actionIndex) => {
      if (
        action.actionProperties.category ===
        codepipeline.ActionCategory.APPROVAL
      ) {
        found.push({
          stageName: stage.stageName,
          actionName: action.actionProperties.actionName,
          stageIndex,
          actionIndex,
        });
      }
    });
  });
  return found;
}

/** Trim a string to at most maxLength characters. */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
