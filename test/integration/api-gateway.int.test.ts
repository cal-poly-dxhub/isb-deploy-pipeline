/**
 * API Gateway smoke tests.
 *
 * The upstream Compute stack publishes the deployed REST API endpoint as a
 * stack output. We use it to verify:
 *
 *   1. The endpoint resolves and returns HTTP (proving CloudFront -> API
 *      Gateway plumbing is wired up).
 *
 *   2. Unauthenticated requests are rejected (proving the authorizer Lambda
 *      and WAF rules are attached).
 *
 * We deliberately do NOT test the happy path with valid auth here, because
 * minting a real IAM Identity Center token requires a test user and SAML
 * round-trip. That belongs in a longer-running functional test suite.
 */
import { describeStack, loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('API Gateway', () => {
  let apiUrl: string;

  beforeAll(async () => {
    // The upstream Compute stack publishes the API URL. The output key
    // contains a CDK hash suffix, so we match by prefix/substring.
    const stack = await describeStack(env.hubRegion, env.stackNames.compute);
    const output = (stack.Outputs ?? []).find(
      (o) =>
        o.OutputKey?.includes('RestApiEndpoint') ||
        o.OutputKey === 'ApiEndpoint' ||
        o.OutputKey === 'ApiGatewayUrl' ||
        o.OutputKey === 'RestApiUrl',
    );
    const resolved = output?.OutputValue;
    if (!resolved) {
      const keys = (stack.Outputs ?? []).map((o) => o.OutputKey).join(', ');
      throw new Error(
        `Could not find an API URL output on stack ${env.stackNames.compute}. ` +
          `Available outputs: ${keys}`,
      );
    }
    apiUrl = resolved.replace(/\/+$/, '');
  });

  it('resolves to an HTTPS endpoint', () => {
    expect(apiUrl).toMatch(/^https:\/\//);
  });

  it('rejects unauthenticated requests with 401 or 403', async () => {
    const response = await fetch(`${apiUrl}/leases`, {
      method: 'GET',
      // Deliberately no Authorization header.
    });
    expect([401, 403]).toContain(response.status);
  });

  it('returns CORS headers on OPTIONS preflight', async () => {
    const response = await fetch(`${apiUrl}/leases`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    // API Gateway commonly returns 200 or 204 on a successful preflight.
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
  });
});
