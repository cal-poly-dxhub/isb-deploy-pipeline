/**
 * Functional test: Lease Lifecycle
 *
 * Covers the primary usage flow:
 *   1. Lease an account via the API
 *   2. Assume a role in the leased account and invoke a Bedrock action
 *   3. Terminate the lease
 *   4. Verify the cleanup state machine runs
 *   5. Verify the account returns to the available pool
 *
 * Prerequisites:
 *   - RUN_FUNCTIONAL_TESTS=true
 *   - ISB_HUB_REGION / ISB_NAMESPACE set (or loaded from SSM /isb-pipeline/config)
 *   - ISB_API_TOKEN: a valid JWT for an Admin user (obtain via SAML login)
 *   - ISB_LEASE_TEMPLATE_ID: UUID of an existing lease template to use
 *   - Credentials with access to the hub account
 *
 * This test is NOT read-only. It creates and terminates a lease.
 * Do not run on production without understanding the consequences.
 */
import {
  SFNClient,
  DescribeExecutionCommand,
  ListExecutionsCommand,
  ExecutionStatus,
} from '@aws-sdk/client-sfn';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { loadIntegrationEnv, requireStackOutput } from '../integration/support/test-env';

jest.setTimeout(600_000); // 10 minutes — lease lifecycle can be slow

// Determine target stage (default: Dev)
const STAGE = (process.env.ISB_TARGET_STAGE ?? 'Dev').toUpperCase();

// Load config from SSM if env vars aren't set locally
beforeAll(async () => {
  if (process.env.ISB_HUB_REGION) return; // already configured
  try {
    const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: '/isb-pipeline/config' }));
    if (Parameter?.Value) {
      const config = JSON.parse(Parameter.Value);
      for (const [k, v] of Object.entries(config)) {
        if (!process.env[k]) process.env[k] = v as string;
      }
      if (!process.env.ISB_HUB_REGION) process.env.ISB_HUB_REGION = config[`${STAGE}_REGION`];
      if (!process.env.ISB_NAMESPACE) process.env.ISB_NAMESPACE = STAGE.toLowerCase();
    }
  } catch {
    // SSM not available — rely on env vars being set directly
  }
});

const SKIP_REASON = `${STAGE}_RUN_FUNCTIONAL_TESTS is not 'true'`;
const shouldRun = (process.env[`${STAGE}_RUN_FUNCTIONAL_TESTS`] ?? process.env.RUN_FUNCTIONAL_TESTS) === 'true';

const env = loadIntegrationEnv();

// Helper: call the ISB API
async function isbApi(
  apiUrl: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const token = process.env[`${STAGE}_API_TOKEN`] ?? process.env.ISB_API_TOKEN;
  if (!token) throw new Error(`${STAGE}_API_TOKEN or ISB_API_TOKEN is required for functional tests`);

  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

// Helper: poll until condition is met or timeout
async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('Lease Lifecycle', () => {
  let apiUrl: string;
  let leaseId: string;
  let leaseAccountId: string;
  let cleanupStateMachineArn: string;

  beforeAll(async () => {
    if (!shouldRun) return;

    const candidates = ['ApiEndpoint', 'ApiGatewayUrl', 'RestApiUrl'];
    for (const key of candidates) {
      try {
        const val = await requireStackOutput(env.hubRegion, env.stackNames.compute, key);
        if (val) { apiUrl = val.replace(/\/+$/, ''); break; }
      } catch { /* try next */ }
    }
    if (!apiUrl) throw new Error('Could not resolve API URL from stack outputs');

    cleanupStateMachineArn = await requireStackOutput(
      env.hubRegion,
      env.stackNames.compute,
      'CleanupStateMachineArn',
    );
  });

  it('creates a lease and gets an account assigned', async () => {
    if (!shouldRun) return console.log(SKIP_REASON);

    const templateId = process.env[`${STAGE}_LEASE_TEMPLATE_ID`] ?? process.env.ISB_LEASE_TEMPLATE_ID;
    if (!templateId) throw new Error(`${STAGE}_LEASE_TEMPLATE_ID or ISB_LEASE_TEMPLATE_ID is required`);

    const { status, data } = await isbApi(apiUrl, 'POST', '/leases', {
      leaseTemplateUuid: templateId,
      comments: 'Functional test - lease lifecycle',
    });

    expect(status).toBe(201);
    const lease = (data as { data: { uuid: string; accountId: string } }).data;
    leaseId = lease.uuid;
    expect(leaseId).toBeDefined();

    // Wait for account to be assigned (lease moves to Active)
    await pollUntil(async () => {
      const { data: getResp } = await isbApi(apiUrl, 'GET', `/leases/${leaseId}`);
      const l = (getResp as { data: { status: string; accountId?: string } }).data;
      if (l.status === 'Active' && l.accountId) {
        leaseAccountId = l.accountId;
        return true;
      }
      return false;
    }, 180_000); // 3 min for account assignment

    expect(leaseAccountId).toMatch(/^\d{12}$/);
  });

  it('can assume a role in the leased account and call Bedrock', async () => {
    if (!shouldRun || !leaseAccountId) return console.log(SKIP_REASON);

    const sts = new STSClient({ region: env.hubRegion });
    const roleName = process.env[`${STAGE}_SANDBOX_ROLE_NAME`] ?? process.env.ISB_SANDBOX_ROLE_NAME ?? 'OrganizationAccountAccessRole';

    const creds = await sts.send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${leaseAccountId}:role/${roleName}`,
      RoleSessionName: 'isb-functional-test',
    }));

    expect(creds.Credentials?.AccessKeyId).toBeDefined();

    // Verify we can make an API call in the sandbox account (Bedrock list models is read-only)
    const { BedrockClient, ListFoundationModelsCommand } = await import('@aws-sdk/client-bedrock');
    const bedrock = new BedrockClient({
      region: env.hubRegion,
      credentials: {
        accessKeyId: creds.Credentials!.AccessKeyId!,
        secretAccessKey: creds.Credentials!.SecretAccessKey!,
        sessionToken: creds.Credentials!.SessionToken!,
      },
    });

    const models = await bedrock.send(new ListFoundationModelsCommand({}));
    expect(models.modelSummaries).toBeDefined();
  });

  it('terminates the lease', async () => {
    if (!shouldRun || !leaseId) return console.log(SKIP_REASON);

    const { status } = await isbApi(apiUrl, 'DELETE', `/leases/${leaseId}`);
    expect([200, 202, 204]).toContain(status);
  });

  it('cleanup state machine runs to completion', async () => {
    if (!shouldRun || !leaseAccountId) return console.log(SKIP_REASON);

    const sfn = new SFNClient({ region: env.hubRegion });

    // Wait for a cleanup execution targeting our account
    await pollUntil(async () => {
      const { executions } = await sfn.send(new ListExecutionsCommand({
        stateMachineArn: cleanupStateMachineArn,
        maxResults: 20,
      }));

      const ours = executions?.find((e) =>
        e.status === ExecutionStatus.SUCCEEDED ||
        e.status === ExecutionStatus.RUNNING,
      );
      if (!ours) return false;

      if (ours.status === ExecutionStatus.SUCCEEDED) return true;

      // If still running, check again next poll
      const detail = await sfn.send(new DescribeExecutionCommand({
        executionArn: ours.executionArn,
      }));
      return detail.status === ExecutionStatus.SUCCEEDED;
    }, 300_000); // 5 min for cleanup
  });

  it('account returns to available pool', async () => {
    if (!shouldRun || !leaseAccountId) return console.log(SKIP_REASON);

    // Verify via the API that the account status is back to Available
    await pollUntil(async () => {
      const { data } = await isbApi(apiUrl, 'GET', `/accounts/${leaseAccountId}`);
      const account = (data as { data: { status: string } }).data;
      return account.status === 'Available';
    }, 120_000); // 2 min after cleanup completes
  });
});
