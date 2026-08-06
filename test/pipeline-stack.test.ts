import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { PipelineConfig } from '../lib/config/environment-config';
import { PipelineStack } from '../lib/pipeline-stack';

const testConfig: PipelineConfig = {
  pipelineName: 'TestInnovationSandboxPipeline',
  toolingEnv: { account: '000000000000', region: 'us-east-1' },
  source: {
    owner: 'aws-solutions',
    repo: 'innovation-sandbox-on-aws',
    branch: 'main',
    codestarConnectionArn:
      'arn:aws:codeconnections:us-east-1:000000000000:connection/abc-123',
  },
  pipelineSource: {
    owner: 'my-org',
    repo: 'isb-deploy-pipeline',
    branch: 'main',
    codestarConnectionArn:
      'arn:aws:codeconnections:us-east-1:000000000000:connection/abc-123',
  },
  buildAndPushNukeImage: false,
  stages: [
    {
      stageName: 'Dev',
      accounts: {
        orgManagement: { account: '111111111111', region: 'us-east-1' },
        idc: { account: '222222222222', region: 'us-east-1' },
        hub: { account: '333333333333', region: 'us-east-1' },
      },
    },
    {
      stageName: 'Prod',
      accounts: {
        orgManagement: { account: '444444444444', region: 'us-east-1' },
        idc: { account: '555555555555', region: 'us-east-1' },
        hub: { account: '666666666666', region: 'us-east-1' },
      },
      requireManualApproval: true,
    },
  ],
};

describe('PipelineStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App({
      context: {
        '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': true,
      },
    });
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      config: testConfig,
      env: testConfig.toolingEnv,
    });
    template = Template.fromStack(stack);
  });

  it('creates a CodePipeline resource with the configured name', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'TestInnovationSandboxPipeline',
    });
  });

  it('creates an encrypted artifact bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
            }),
          }),
        ]),
      }),
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
      }),
    });
  });

  it('creates a KMS key with rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('includes both Dev and Prod stages with all four upstream stack steps', () => {
    const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
    const props = Object.values(pipelines)[0].Properties;
    const stageNames = (props.Stages as Array<{ Name: string }>).map(
      (s) => s.Name,
    );
    expect(stageNames).toEqual(
      expect.arrayContaining(['Source', 'Build', 'Dev', 'Prod']),
    );
  });

  it('inserts a manual approval action for the Prod stage', () => {
    const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
    const props = Object.values(pipelines)[0].Properties;
    const allActionTypes = (props.Stages as Array<{ Actions: Array<{ ActionTypeId: { Category: string } }> }>)
      .flatMap((s) => s.Actions)
      .map((a) => a.ActionTypeId.Category);
    expect(allActionTypes).toContain('Approval');
  });

  it('is a V2 pipeline in SUPERSEDED execution mode', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineType: 'V2',
      ExecutionMode: 'SUPERSEDED',
    });
  });

  it('names both source actions explicitly', () => {
    const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
    const props = Object.values(pipelines)[0].Properties;
    const sourceStage = (props.Stages as Array<{ Name: string; Actions: Array<{ Name: string }> }>)
      .find((s) => s.Name === 'Source');
    expect(sourceStage?.Actions.map((a) => a.Name).sort()).toEqual([
      'PipelineRepoSource',
      'UpstreamRepoSource',
    ]);
  });

  it('registers a push trigger for BOTH source actions', () => {
    // Regression: only the upstream source used to have a trigger, and its
    // action name was resolved by substring match, so pushes to the pipeline
    // repo could stop starting executions.
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Triggers: Match.arrayWith([
        {
          ProviderType: 'CodeStarSourceConnection',
          GitConfiguration: {
            SourceActionName: 'PipelineRepoSource',
            Push: [{ Branches: { Includes: ['main'] } }],
          },
        },
        {
          ProviderType: 'CodeStarSourceConnection',
          GitConfiguration: {
            SourceActionName: 'UpstreamRepoSource',
            Push: [{ Branches: { Includes: ['main'] } }],
          },
        },
      ]),
    });
  });

  it('starts an execution when the SSM config parameter changes', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.ssm'],
        'detail-type': ['Parameter Store Change'],
        detail: {
          name: ['/isb-pipeline/config', 'isb-pipeline/config'],
          operation: ['Create', 'Update', 'LabelParameterVersion'],
        },
      },
      State: 'ENABLED',
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({
            'Fn::Join': Match.anyValue(),
          }),
          RetryPolicy: { MaximumRetryAttempts: 2 },
        }),
      ]),
    });
  });

  it('loads config from SSM before synthesising the upstream app', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const synth = Object.values(projects).find((p) =>
      JSON.stringify(p.Properties.Source?.BuildSpec ?? '').includes(
        'load_ssm_config.sh',
      ),
    );
    expect(synth).toBeDefined();

    const buildSpec = JSON.stringify(synth!.Properties.Source.BuildSpec);
    expect(buildSpec.indexOf('load_ssm_config.sh')).toBeLessThan(
      buildSpec.indexOf('Synth upstream Innovation Sandbox CDK app'),
    );
    expect(buildSpec).toContain('--context configHash=');
    expect(buildSpec).toContain('$ISB_CONFIG_HASH');
  });
});

describe('PipelineStack config-change trigger opt-out', () => {
  it('omits the EventBridge rule when triggerOnConfigChange is false', () => {
    const app = new App({
      context: {
        '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': true,
      },
    });
    const stack = new PipelineStack(app, 'NoTriggerPipelineStack', {
      config: { ...testConfig, triggerOnConfigChange: false },
      env: testConfig.toolingEnv,
    });
    const rules = Template.fromStack(stack).findResources(
      'AWS::Events::Rule',
      {
        Properties: {
          EventPattern: Match.objectLike({ source: ['aws.ssm'] }),
        },
      },
    );
    expect(Object.keys(rules)).toHaveLength(0);
  });

  it('honours a custom config parameter name', () => {
    const app = new App({
      context: {
        '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': true,
      },
    });
    const stack = new PipelineStack(app, 'CustomParamPipelineStack', {
      config: { ...testConfig, configParameterName: '/custom/isb' },
      env: testConfig.toolingEnv,
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        detail: Match.objectLike({ name: ['/custom/isb', 'custom/isb'] }),
      }),
    });
  });
});
