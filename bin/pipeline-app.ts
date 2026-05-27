#!/usr/bin/env node
import 'source-map-support/register';
import { App, Aspects, IAspect, Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

import { defaultPipelineConfig } from '../lib/config/pipeline-config';
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

app.synth();
