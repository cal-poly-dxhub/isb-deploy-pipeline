import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
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

import { PipelineConfig } from './config/environment-config';
import { addInnovationSandboxDeployment } from './stages/innovation-sandbox-wave';

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
    // Config hash forces self-mutation when SSM config changes
    const configHash = this.node.tryGetContext('configHash') ?? 'local';
    Tags.of(this).add('ConfigHash', configHash);
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
      },
    );

    // ADDITIONAL source: upstream Innovation Sandbox repo.
    const upstreamSource = CodePipelineSource.connection(
      `${config.source.owner}/${config.source.repo}`,
      config.source.branch,
      {
        connectionArn: config.source.codestarConnectionArn!,
        triggerOnPush: true,
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
    const synthEnv: Record<string, string> = {
      NODE_OPTIONS: '--max-old-space-size=8192',
      // Upstream synth needs these unprefixed
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
        'npm install -g aws-cdk@2.167.1',
      ],
      commands: [
        'set -eu',
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
        'cd $CODEBUILD_SRC_DIR',
        // Load config from SSM Parameter Store into environment
        'echo "==> Loading config from SSM"',
        'export ISB_CONFIG=$(aws ssm get-parameter --name /isb-pipeline/config --region us-west-2 --query Parameter.Value --output text)',
        'eval $(echo $ISB_CONFIG | jq -r \'to_entries[] | "export \\(.key)=\\(.value)"\')',
        'npm ci --no-audit --no-fund',
        'npx cdk synth --context configHash=$(echo $ISB_CONFIG | md5sum | cut -d" " -f1)',
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
            'runtime-versions': { nodejs: '22' },
          },
        },
      }),
      timeout: Duration.minutes(120),
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
      cliVersion: '2.167.1',
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
              'runtime-versions': { nodejs: '22' },
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
        timeout: Duration.minutes(240),
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
        scope: this,
      });
    }

    // ------------------------------------------------------------------
    // 6. Notifications
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
      // CodeStar Notifications integration is added at synth time after the
      // pipeline buildup has finished. We pass an explicit short name because
      // CodeStar Notifications enforces a 64-character limit on rule names
      // and the CDK auto-generated name (which prefixes the construct path)
      // can exceed that.
      this.pipeline.buildPipeline();
      this.pipeline.pipeline.notifyOn('PipelineFailures', topic, {
        notificationRuleName: truncate(`${config.pipelineName}-failures`, 64),
        events: [
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_CANCELED,
          codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_NEEDED,
        ],
      });
    }
  }
}

/** Trim a string to at most maxLength characters. */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
