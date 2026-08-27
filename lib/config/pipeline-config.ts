import * as path from 'path';
import * as dotenv from 'dotenv';

import {
  AwsEnvironment,
  DeploymentStageConfig,
  PipelineConfig,
} from './environment-config';

// Load variables from a .env file at the repository root if present. Variables
// already set in the shell take precedence (override: false). This is used for
// local development only. In CodeBuild, env vars come from SSM via the synth step.
dotenv.config({
  path: path.resolve(__dirname, '..', '..', '.env'),
  override: false,
});

/**
 * Reads a required environment variable. Throws if the variable is missing or
 * empty so misconfiguration fails fast at synth time instead of producing a
 * broken pipeline.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Required environment variable ${name} is missing. ` +
        `Set it in your shell or in the .env file at the repository root. ` +
        `See .env.example for the full list of supported variables.`,
    );
  }
  return value.trim();
}

/**
 * Reads an optional environment variable, returning the fallback if unset.
 */
function optionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Reads a boolean env var. Accepts "true", "1", "yes", "y" (case-insensitive).
 */
function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return ['true', '1', 'yes', 'y'].includes(raw.trim().toLowerCase());
}

/**
 * Reads a comma-separated list env var into a trimmed string array.
 */
function listEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * The set of "well-known" upstream Innovation Sandbox environment variables.
 * Each one can be set per-stage via `<PREFIX>_<KEY>` in `.env`. If set, the
 * value is forwarded to the upstream `cdk deploy` invocation as `<KEY>`.
 *
 * If the upstream solution requires a variable that is not listed here, add
 * it to this array and document it in `.env.example`.
 */
const UPSTREAM_PASSTHROUGH_KEYS: ReadonlyArray<string> = [
  // AccountPool stack parameters.
  'PARENT_OU_ID',
  'AWS_REGIONS',

  // IAM Identity Center wiring (required by the IDC and Compute stacks).
  'IDENTITY_STORE_ID',
  'SSO_INSTANCE_ARN',

  // IDC group name overrides (optional; upstream provides defaults).
  'ADMIN_GROUP_NAME',
  'MANAGER_GROUP_NAME',
  'USER_GROUP_NAME',

  // Network/security tuning.
  'ALLOWED_IP_ADDRESSES',

  // Cleanup behavior tuning.
  'AWS_NUKE_DRY_RUN_MODE',

  // Required ToS acknowledgement on some upstream releases.
  'ACCEPT_SOLUTION_TERMS_OF_USE',
];

/**
 * Builds an AwsEnvironment for a stage by reading <PREFIX>_ORG_MGT_ACCOUNT,
 * <PREFIX>_IDC_ACCOUNT, <PREFIX>_HUB_ACCOUNT and the per-stage region (with
 * fallback to the global default region).
 */
function readStage(
  stageName: string,
  defaultRegion: string,
): DeploymentStageConfig | undefined {
  const prefix = stageName.toUpperCase();
  const orgMgt = optionalEnv(`${prefix}_ORG_MGT_ACCOUNT`);
  const idc = optionalEnv(`${prefix}_IDC_ACCOUNT`);
  const hub = optionalEnv(`${prefix}_HUB_ACCOUNT`);

  // A stage is considered "enabled" only if all three account IDs are set.
  // This lets users define a subset of stages (e.g. just Dev) by leaving the
  // rest blank in .env.
  if (!orgMgt || !idc || !hub) {
    return undefined;
  }

  const region = optionalEnv(`${prefix}_REGION`, defaultRegion)!;
  const env = (account: string): AwsEnvironment => ({ account, region });

  // Start with NAMESPACE then layer in any well-known upstream vars that
  // happen to be set for this stage. Variables left unset are simply not
  // forwarded (the upstream uses its built-in defaults).
  const envOverrides: Record<string, string> = {
    NAMESPACE: optionalEnv(`${prefix}_NAMESPACE`, stageName.toLowerCase())!,
  };
  for (const key of UPSTREAM_PASSTHROUGH_KEYS) {
    const value = optionalEnv(`${prefix}_${key}`);
    if (value) {
      envOverrides[key] = value;
    }
  }

  return {
    stageName,
    accounts: {
      orgManagement: env(orgMgt),
      idc: env(idc),
      hub: env(hub),
    },
    requireManualApproval: booleanEnv(
      `${prefix}_REQUIRE_MANUAL_APPROVAL`,
      stageName !== 'Dev', // default: gate Staging/Prod, not Dev
    ),
    approvalNotificationEmails: listEnv(`${prefix}_APPROVAL_EMAILS`),
    runIntegrationTests: booleanEnv(
      `${prefix}_RUN_INTEGRATION_TESTS`,
      stageName === 'Dev',
    ),
    envOverrides,
  };
}

/**
 * Builds the full PipelineConfig from environment variables. See
 * `.env.example` for the full list and documentation of each variable.
 */
export function loadPipelineConfig(): PipelineConfig {
  const defaultRegion = optionalEnv(
    'CDK_DEFAULT_REGION',
    optionalEnv('AWS_REGION', 'us-east-1'),
  )!;

  const toolingAccount = requireEnv('TOOLING_ACCOUNT');
  const toolingRegion = optionalEnv('TOOLING_REGION', defaultRegion)!;

  // Build stage list from env vars. Unconfigured stages are skipped so a
  // single .env can drive a single-environment install.
  const stages = ['Dev', 'Staging', 'Prod']
    .map((name) => readStage(name, defaultRegion))
    .filter((s): s is DeploymentStageConfig => s !== undefined);

  if (stages.length === 0) {
    throw new Error(
      'No deployment stages configured. Set at least DEV_ORG_MGT_ACCOUNT, ' +
        'DEV_IDC_ACCOUNT, and DEV_HUB_ACCOUNT (or the equivalents for ' +
        'STAGING/PROD) in your .env file.',
    );
  }

  return {
    pipelineName: optionalEnv('PIPELINE_NAME', 'InnovationSandboxPipeline')!,
    toolingEnv: {
      account: toolingAccount,
      region: toolingRegion,
    },
    source: {
      owner: optionalEnv('GITHUB_OWNER', 'aws-solutions')!,
      repo: optionalEnv('GITHUB_REPO', 'innovation-sandbox-on-aws')!,
      branch: optionalEnv('GITHUB_BRANCH', 'main')!,
      codestarConnectionArn: requireEnv('UPSTREAM_CODESTAR_CONNECTION_ARN'),
    },
    pipelineSource: {
      owner: requireEnv('PIPELINE_GITHUB_OWNER'),
      repo: requireEnv('PIPELINE_GITHUB_REPO'),
      branch: optionalEnv('PIPELINE_GITHUB_BRANCH', 'main')!,
      codestarConnectionArn: requireEnv('PIPELINE_CODESTAR_CONNECTION_ARN'),
    },
    buildAndPushNukeImage: booleanEnv('BUILD_AND_PUSH_NUKE_IMAGE', false),
    configParameterName: optionalEnv(
      'CONFIG_PARAMETER_NAME',
      '/isb-pipeline/config',
    )!,
    triggerOnConfigChange: booleanEnv('TRIGGER_ON_CONFIG_CHANGE', true),
    unblockStaleApprovals: booleanEnv('UNBLOCK_STALE_APPROVALS', true),
    diffVerbose: booleanEnv('DIFF_VERBOSE', false),
    notificationEmails: listEnv('NOTIFICATION_EMAILS'),
    stages,
  };
}

/**
 * Default config, loaded eagerly. Importing this triggers env validation. If
 * you need to construct a config programmatically (e.g. in tests), import the
 * `PipelineConfig` interface from `environment-config.ts` instead and build
 * one by hand.
 */
export const defaultPipelineConfig: PipelineConfig = loadPipelineConfig();
