#!/usr/bin/env node
import 'source-map-support/register';
import * as fs from 'fs';
import * as path from 'path';
import { App, Aspects, IAspect, Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

import { defaultPipelineConfig } from '../lib/config/pipeline-config';
import {
  renderStageConfigFile,
  stageConfigFileName,
} from '../lib/config/stage-config-file';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new App();

// Allow runtime override of the config file via context, e.g.:
//   cdk deploy -c configPath=./config/prod.json
// This keeps the codebase generic while letting individual operators ship
// account-specific values via context or a JSON file.
const configPathOverride = app.node.tryGetContext('configPath') as
  | string
  | undefined;

let config = defaultPipelineConfig;
if (configPathOverride) {
  // Lazy-require so unit tests don't need the file to exist.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const overridden = require(configPathOverride) as {
    default?: typeof defaultPipelineConfig;
  };
  if (overridden.default) {
    config = overridden.default;
  }
}

new PipelineStack(app, 'InnovationSandboxPipelineStack', {
  config,
  env: config.toolingEnv,
  description:
    'Self-mutating CDK Pipeline that deploys Innovation Sandbox on AWS to multiple accounts and stages.',
});

// Add a baseline set of tags to every resource the pipeline creates.
Tags.of(app).add('Solution', 'InnovationSandbox');
Tags.of(app).add('IaC', 'CDK');

// Lightweight aspect that warns if a Stack is missing an explicit env
// (account/region). CDK Pipelines will emit an opaque error otherwise.
class RequireExplicitEnvAspect implements IAspect {
  public visit(node: IConstruct): void {
    if ('account' in node && 'region' in node) {
      const stack = node as { account?: string; region?: string };
      if (!stack.account || !stack.region) {
        // eslint-disable-next-line no-console
        console.warn(
          `Stack ${(node as { node: { path: string } }).node.path} is missing an explicit env { account, region }.`,
        );
      }
    }
  }
}
Aspects.of(app).add(new RequireExplicitEnvAspect());

const assembly = app.synth();

// Write each stage's resolved configuration into the cloud assembly. These
// files travel with the synth artifact, and the deploy/test steps source them
// at runtime. Keeping config OUT of the pipeline definition means editing a
// value like NAMESPACE or PARENT_OU_ID produces no CloudFormation diff, so no
// self-mutation and no `RestartExecutionOnUpdate` second execution.
for (const stage of config.stages) {
  fs.writeFileSync(
    path.join(assembly.directory, stageConfigFileName(stage.stageName)),
    renderStageConfigFile(stage),
    { encoding: 'utf-8' },
  );
}
