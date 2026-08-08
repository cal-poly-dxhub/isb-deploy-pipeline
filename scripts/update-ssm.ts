#!/usr/bin/env node
/**
 * Publishes the local `.env` to the SSM parameter the pipeline reads at synth
 * time.
 *
 *   npm run config:push            # uses ./.env
 *   npm run config:push -- ./other.env
 *
 * Environment:
 *   AWS_REGION   overrides the region (otherwise TOOLING_REGION from the file)
 *   PARAM_NAME   overrides the parameter name
 *   FORCE=1      write a new parameter version even when nothing changed
 *
 * This deliberately does NOT start a pipeline execution. The pipeline stack owns
 * an EventBridge rule on the Parameter Store change event, so a run is triggered
 * no matter how the parameter was edited - this script, the AWS console, the
 * CLI, or anything else.
 *
 * Written in TypeScript rather than shell specifically so it can share `dotenv`
 * with lib/config/pipeline-config.ts. A hand-rolled parser is a second
 * implementation of the same file format, and the two drift: an unquoted '#'
 * (`A=bar#baz`) was previously published as `bar#baz` but read back at synth as
 * `bar`.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import * as dotenv from 'dotenv';

export const DEFAULT_PARAMETER_NAME = '/isb-pipeline/config';
export const DEFAULT_REGION = 'us-east-1';

/**
 * Parses a `.env` file using the same library, and therefore the same rules,
 * that `loadPipelineConfig()` uses when it reads the file directly.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  return dotenv.parse(contents);
}

/**
 * Serialises the config for storage.
 *
 * Keys are sorted and separators are compact so that an unchanged `.env`
 * always produces a byte-identical string; the idempotency check below is a
 * plain comparison against the stored value.
 */
export function serialiseConfig(config: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(config).sort()) {
    sorted[key] = config[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Region precedence: AWS_REGION, then TOOLING_REGION from the file, then the
 * same default `loadPipelineConfig()` falls back to.
 */
export function resolveRegion(
  config: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.AWS_REGION?.trim() ||
    config.TOOLING_REGION?.trim() ||
    DEFAULT_REGION
  );
}

async function readCurrentValue(
  client: SSMClient,
  name: string,
): Promise<string | undefined> {
  try {
    const response = await client.send(
      new GetParameterCommand({ Name: name }),
    );
    return response.Parameter?.Value;
  } catch (error) {
    if ((error as { name?: string }).name === 'ParameterNotFound') {
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const envFile =
    process.argv[2] ?? path.resolve(__dirname, '..', '.env');

  if (!fs.existsSync(envFile)) {
    throw new Error(`${envFile} not found`);
  }

  const config = parseEnvFile(fs.readFileSync(envFile, 'utf-8'));
  if (Object.keys(config).length === 0) {
    throw new Error(`No variable assignments found in ${envFile}`);
  }

  const value = serialiseConfig(config);
  const region = resolveRegion(config);
  const name = process.env.PARAM_NAME?.trim() || DEFAULT_PARAMETER_NAME;

  const client = new SSMClient({ region });
  const current = await readCurrentValue(client, name);

  if (process.env.FORCE !== '1' && current === value) {
    console.log(`${name} in ${region} is already up to date; nothing to do.`);
    console.log(
      '(Set FORCE=1 to write a new version and trigger a pipeline run anyway.)',
    );
    return;
  }

  await client.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'String',
      Tier: 'Intelligent-Tiering',
      Overwrite: true,
    }),
  );

  console.log(
    `Updated ${name} in ${region} (${Object.keys(config).length} variables)`,
  );
  console.log(
    "The pipeline's config-change EventBridge rule will start a new execution.",
  );
}

// Only run when invoked directly, so the helpers above stay importable by tests.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
