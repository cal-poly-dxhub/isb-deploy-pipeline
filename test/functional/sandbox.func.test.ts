/**
 * Category 2: Sandbox Validation
 *
 * Tests access to the leased sandbox account.
 * Requires sandbox credentials in .env.functional.
 * Run: npm run test:functional -- --testPathPattern=2-sandbox
 */
import { config, loadState } from './helpers';

jest.setTimeout(60_000);

const sandboxCreds = {
  accessKeyId: process.env.ISB_SANDBOX_AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.ISB_SANDBOX_AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.ISB_SANDBOX_AWS_SESSION_TOKEN,
};

describe('Sandbox Validation', () => {
  it('has sandbox credentials configured', () => {
    expect(sandboxCreds.accessKeyId).toBeDefined();
    expect(sandboxCreds.secretAccessKey).toBeDefined();
    const state = loadState();
    expect(state.leaseAccountId).toBeDefined();
    console.log(`Testing account: ${state.leaseAccountId}`);
  });

  it('can call Bedrock', async () => {
    const { BedrockClient, ListFoundationModelsCommand } = await import('@aws-sdk/client-bedrock');
    const bedrock = new BedrockClient({
      region: config.hubRegion,
      credentials: sandboxCreds,
    });

    const models = await bedrock.send(new ListFoundationModelsCommand({}));
    expect(models.modelSummaries).toBeDefined();
    expect(models.modelSummaries!.length).toBeGreaterThan(0);
    console.log(`✓ Bedrock: ${models.modelSummaries!.length} models available`);
  });

  it('can list S3 buckets', async () => {
    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: config.hubRegion, credentials: sandboxCreds });

    const result = await s3.send(new ListBucketsCommand({}));
    expect(result.Buckets).toBeDefined();
    console.log(`✓ S3: ${result.Buckets!.length} buckets`);
  });

  it('can describe EC2 resources', async () => {
    const { EC2Client, DescribeVpcsCommand } = await import('@aws-sdk/client-ec2');
    const ec2 = new EC2Client({ region: config.hubRegion, credentials: sandboxCreds });

    const result = await ec2.send(new DescribeVpcsCommand({}));
    expect(result.Vpcs).toBeDefined();
    console.log(`✓ EC2: ${result.Vpcs!.length} VPCs`);

    console.log(`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  Sandbox validation complete.\n` +
      `  To teardown: npm run test:functional -- --testPathPattern=3-teardown\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
    );
  });
});
