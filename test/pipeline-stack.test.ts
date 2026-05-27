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
});
