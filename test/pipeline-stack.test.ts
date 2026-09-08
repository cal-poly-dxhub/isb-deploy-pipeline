import { spawnSync } from 'child_process';
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
      runIntegrationTests: true,
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

  it('renders a diff immediately before each approval', () => {
    const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
    const props = Object.values(pipelines)[0].Properties;
    const prod = (
      props.Stages as Array<{
        Name: string;
        Actions: Array<{
          Name: string;
          RunOrder: number;
          ActionTypeId: { Category: string };
        }>;
      }>
    ).find((s) => s.Name === 'Prod')!;

    const diff = prod.Actions.find((a) => a.Name === 'Diff-Prod');
    const approval = prod.Actions.find((a) => a.Name === 'Approve-Prod');
    expect(diff).toBeDefined();
    expect(approval).toBeDefined();
    // The diff has to be published before the approval starts waiting.
    expect(diff!.RunOrder).toBeLessThan(approval!.RunOrder);
    // ...and before anything is actually deployed.
    const firstDeploy = prod.Actions.filter((a) =>
      a.Name.startsWith('Deploy-'),
    ).map((a) => a.RunOrder);
    expect(Math.min(...firstDeploy)).toBeGreaterThan(approval!.RunOrder);
  });

  it('gives each approval a clickable link to its diff', () => {
    const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
    const props = Object.values(pipelines)[0].Properties;
    const approvals = (
      props.Stages as Array<{
        Name: string;
        Actions: Array<{
          ActionTypeId: { Category: string };
          Configuration: Record<string, unknown>;
        }>;
      }>
    )
      .flatMap((s) => s.Actions.map((a) => ({ stage: s.Name, action: a })))
      .filter(({ action }) => action.ActionTypeId.Category === 'Approval');

    expect(approvals).toHaveLength(1);
    for (const { stage, action } of approvals) {
      // ExternalEntityLink is what the console renders as a link; CustomData
      // repeats it so it also shows up in the approval notification email.
      const link = JSON.stringify(action.Configuration.ExternalEntityLink);
      expect(link).toContain('s3.console.aws.amazon.com');
      expect(link).toContain(`diffs%2F${stage}%2Flatest.txt`);
      expect(JSON.stringify(action.Configuration.CustomData)).toContain(
        `diffs%2F${stage}%2Flatest.txt`,
      );
    }
  });

  it('publishes the diff as UTF-8 so the box-drawing tree renders', () => {
    // Without an explicit charset the browser guesses (often windows-1252) and
    // cdk diff's │├─└ characters come out as mojibake.
    const projects = template.findResources('AWS::CodeBuild::Project');
    const diff = Object.values(projects).find((p) =>
      JSON.stringify(p.Properties.Source?.BuildSpec ?? '').includes(
        'render_stage_diff.sh',
      ),
    );
    expect(diff).toBeDefined();
    const buildSpec = JSON.stringify(diff!.Properties.Source.BuildSpec);
    expect(buildSpec).toContain('text/plain; charset=utf-8');
  });

  it('scopes the diff step to the named deploy role and the diffs/ prefix', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const diffPolicy = Object.entries(policies).find(([name]) =>
      name.includes('DiffProd'),
    );
    expect(diffPolicy).toBeDefined();

    const statements = diffPolicy![1].Properties.PolicyDocument
      .Statement as Array<{ Action: string | string[]; Resource: unknown }>;

    const assume = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return (
        actions.includes('sts:AssumeRole') &&
        JSON.stringify(s.Resource).includes('InnovationSandboxPipelineDeployRole')
      );
    });
    expect(assume).toBeDefined();
    // Never a blanket role/* grant.
    expect(JSON.stringify(assume!.Resource)).not.toContain(':role/*');

    const put = statements.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('s3:PutObject');
    });
    expect(JSON.stringify(put!.Resource)).toContain('/diffs/*');
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
  });

  it('does NOT tag resources with a config hash', () => {
    // A stack-wide ConfigHash tag lands on the pipeline resource itself, which
    // guarantees a template diff on every config change -> self-mutation ->
    // RestartExecutionOnUpdate -> a second execution for one config edit.
    const tagged = Object.values(template.toJSON().Resources as Record<
      string,
      { Properties?: { Tags?: unknown } }
    >).filter((r) => {
      const tags = r.Properties?.Tags;
      return (
        Array.isArray(tags) &&
        tags.some(
          (t) => typeof t === 'object' && t !== null && (t as { Key?: string }).Key === 'ConfigHash',
        )
      );
    });
    expect(tagged).toHaveLength(0);
  });

  it('does not bake per-stage config into any CodeBuild project', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const offenders: string[] = [];
    for (const [name, project] of Object.entries(projects)) {
      const vars = (project.Properties.Environment?.EnvironmentVariables ??
        []) as Array<{ Name: string }>;
      const names = vars.map((v) => v.Name);
      const leaked = names.filter((n) =>
        [
          'NAMESPACE',
          'ISB_NAMESPACE',
          'PARENT_OU_ID',
          'IDENTITY_STORE_ID',
          'SSO_INSTANCE_ARN',
          'AWS_REGIONS',
          'ADMIN_GROUP_NAME',
        ].includes(n),
      );
      if (leaked.length > 0) {
        offenders.push(`${name}: ${leaked.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has deploy steps source the stage config from the synth artifact', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const deployProjects = Object.entries(projects).filter(([name]) =>
      name.includes('Deploy'),
    );
    expect(deployProjects.length).toBeGreaterThan(0);
    for (const [name, project] of deployProjects) {
      const buildSpec = JSON.stringify(project.Properties.Source.BuildSpec);
      const stage = name.includes('Prod') ? 'Prod' : 'Dev';
      expect(buildSpec).toContain(`../isb-config/isb-config-${stage}.env`);
    }
  });


  it('uses the Node 24 runtime required by upstream v1.3.0', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    expect(Object.keys(projects).length).toBeGreaterThan(0);
    for (const project of Object.values(projects)) {
      expect(project.Properties.Environment.Image).toBe(
        'aws/codebuild/standard:7.0',
      );
      const buildSpec = JSON.stringify(
        project.Properties.Source.BuildSpec,
      ).replace(/\\/g, '');
      expect(buildSpec).toContain('"nodejs": "24"');
    }
  });

  it('gives the integration suite enough Node heap and CodeBuild memory', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const integration = Object.entries(projects).find(([name]) =>
      name.includes('IntegrationTest'),
    );
    expect(integration).toBeDefined();
    const project = integration![1];
    expect(project.Properties.Environment.ComputeType).toBe(
      'BUILD_GENERAL1_MEDIUM',
    );
    expect(project.Properties.Environment.EnvironmentVariables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Name: 'NODE_OPTIONS',
          Value: '--max-old-space-size=4096',
        }),
      ]),
    );
  });

  it('passes required v1.3.0 authentication and namespace parameters', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const buildSpecs = Object.values(projects).map((project) =>
      JSON.stringify(project.Properties.Source.BuildSpec),
    );
    const deploySpec = (stack: string) => {
      const spec = buildSpecs.find((candidate) =>
        candidate.includes(`Deploying upstream stack: ${stack}`),
      );
      expect(spec).toBeDefined();
      return spec!;
    };

    for (const stack of ['account-pool', 'idc', 'data', 'compute']) {
      expect(deploySpec(stack)).toContain('Namespace=${NAMESPACE');
    }
    expect(deploySpec('data')).toContain(
      'SamlMetadataUrl=${SAML_METADATA_URL',
    );
    expect(deploySpec('data')).toContain(
      'AwsAccessPortalUrl=${AWS_ACCESS_PORTAL_URL',
    );
    expect(deploySpec('account-pool')).toContain(
      'AdditionalPrincipalExceptions',
    );
    expect(deploySpec('account-pool')).toContain(
      'BedrockInferenceProfilePatterns',
    );
    expect(deploySpec('compute')).toContain('AllowListedIPRanges');
  });

  it('generates POSIX-compatible deploy commands for CodeBuild /bin/sh', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const deployProjects = Object.entries(projects).filter(([name]) =>
      name.includes('Deploy'),
    );
    expect(deployProjects.length).toBeGreaterThan(0);

    for (const [name, project] of deployProjects) {
      const rawBuildSpec = project.Properties.Source.BuildSpec;
      expect(typeof rawBuildSpec).toBe('string');
      const buildSpec = JSON.parse(rawBuildSpec as string);
      const commands = buildSpec.phases.build.commands as string[];
      const script = commands.join('\n');

      expect(script).toContain('set -- --context');
      expect(script).toContain('"$@"');
      expect(script).not.toMatch(/CDK_CONTEXT_ARGS|\+=\(|=\([^)]/);

      const syntax = spawnSync('/bin/sh', ['-n'], {
        input: script,
        encoding: 'utf8',
      });
      expect({ name, status: syntax.status, stderr: syntax.stderr }).toEqual({
        name,
        status: 0,
        stderr: '',
      });

      const optionalContexts = commands.filter((command) =>
        command.startsWith('if [ -n '),
      );
      const setE = spawnSync('/bin/sh', ['-eu'], {
        input: optionalContexts.join('\n'),
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect({ name, status: setE.status, stderr: setE.stderr }).toEqual({
        name,
        status: 0,
        stderr: '',
      });
    }
  });

  it('creates an approval unblocker for every manual approval action', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Environment: {
        Variables: Match.objectLike({
          PIPELINE_NAME: 'TestInnovationSandboxPipeline',
          APPROVAL_ACTIONS: JSON.stringify([
            { stageName: 'Prod', actionName: 'Approve-Prod' },
          ]),
        }),
      },
    });

    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.codepipeline'],
        'detail-type': [
          'CodePipeline Pipeline Execution State Change',
          'CodePipeline Stage Execution State Change',
        ],
        detail: {
          pipeline: ['TestInnovationSandboxPipeline'],
          state: ['STARTED', 'SUCCEEDED'],
        },
      },
    });
  });

  it('scopes PutApprovalResult to the specific approval action ARNs', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p) =>
        p.Properties.PolicyDocument.Statement as Array<{
          Action: string | string[];
          Resource: unknown;
        }>,
    );
    const approvalStatements = statements.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('codepipeline:PutApprovalResult');
    });
    expect(approvalStatements).toHaveLength(1);
    // Must be a per-action ARN (…/Prod/Approve-Prod), never a bare wildcard.
    expect(JSON.stringify(approvalStatements[0].Resource)).toContain(
      '/Prod/Approve-Prod',
    );
    expect(approvalStatements[0].Resource).not.toBe('*');
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

  it('omits the approval unblocker when unblockStaleApprovals is false', () => {
    const app = new App({
      context: {
        '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': true,
      },
    });
    const stack = new PipelineStack(app, 'NoUnblockerPipelineStack', {
      config: { ...testConfig, unblockStaleApprovals: false },
      env: testConfig.toolingEnv,
    });
    const t = Template.fromStack(stack);
    const statements = Object.values(t.findResources('AWS::IAM::Policy'))
      .flatMap(
        (p) =>
          p.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
          }>,
      )
      .filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('codepipeline:PutApprovalResult');
      });
    expect(statements).toHaveLength(0);
  });

  it('omits the approval unblocker when no stage requires approval', () => {
    const app = new App({
      context: {
        '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': true,
      },
    });
    const stack = new PipelineStack(app, 'NoApprovalsPipelineStack', {
      config: {
        ...testConfig,
        stages: testConfig.stages.map((s) => ({
          ...s,
          requireManualApproval: false,
        })),
      },
      env: testConfig.toolingEnv,
    });
    const rules = Template.fromStack(stack).findResources('AWS::Events::Rule', {
      Properties: {
        EventPattern: Match.objectLike({ source: ['aws.codepipeline'] }),
      },
    });
    expect(Object.keys(rules)).toHaveLength(0);
  });
});
