import { DeploymentStageConfig } from './environment-config';

/**
 * Directory (relative to a step's primary input) where the synth output is
 * mounted as an additional input so that deploy/test steps can read the
 * per-stage config file out of the cloud assembly.
 */
export const CONFIG_INPUT_DIR = '../isb-config';

/**
 * Name of the per-stage config file written into the cloud assembly.
 */
export function stageConfigFileName(stageName: string): string {
  return `isb-config-${stageName}.env`;
}

/**
 * Path a step uses to source its stage config at runtime.
 */
export function stageConfigPath(stageName: string): string {
  return `${CONFIG_INPUT_DIR}/${stageConfigFileName(stageName)}`;
}

/**
 * The resolved upstream environment for a stage.
 *
 * This is deliberately the *only* place per-stage config values are assembled,
 * so the file written into the artifact and the values the deploy steps consume
 * cannot drift apart.
 */
export function resolveStageEnv(
  stage: DeploymentStageConfig,
): Record<string, string> {
  return {
    ...(stage.envOverrides ?? {}),
    ORG_MGT_ACCOUNT_ID: stage.accounts.orgManagement.account,
    IDC_ACCOUNT_ID: stage.accounts.idc.account,
    HUB_ACCOUNT_ID: stage.accounts.hub.account,
  };
}

/**
 * Renders a stage's resolved config as a shell-sourceable file.
 *
 * Consumed as `set -a && . <file> && set +a`, so every assignment must be
 * single-quoted to survive spaces, '#', and quotes inside values.
 */
export function renderStageConfigFile(stage: DeploymentStageConfig): string {
  const env = resolveStageEnv(stage);
  const header = [
    `# Resolved configuration for the ${stage.stageName} stage.`,
    '#',
    '# Generated during `cdk synth` and carried inside the cloud assembly, so',
    '# deploy steps read config at RUNTIME instead of having it baked into the',
    '# pipeline definition. That is what stops a config-only change from',
    '# producing a pipeline diff (and therefore a self-mutation plus a second,',
    '# restarted execution).',
    '#',
    '# Do not edit by hand - edit .env and run scripts/update_ssm.sh.',
  ];
  const body = Object.keys(env)
    .sort()
    .map((key) => `${key}=${shellQuote(env[key])}`);
  return [...header, ...body, ''].join('\n');
}

/**
 * Wraps a value in single quotes, escaping any embedded single quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
