/**
 * CloudFront / web UI smoke tests.
 *
 * The Compute stack publishes the CloudFront distribution domain as a stack
 * output. We hit the root URL and assert the SPA shell loads.
 */
import {
  CloudFrontClient,
  GetDistributionCommand,
} from '@aws-sdk/client-cloudfront';

import { getStackOutput, loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('Web UI (CloudFront)', () => {
  let distributionId: string | undefined;
  let webUrl: string | undefined;

  beforeAll(async () => {
    distributionId = await getStackOutput(
      env.hubRegion,
      env.stackNames.compute,
      'WebUiDistributionId',
    );

    const domain = await getStackOutput(
      env.hubRegion,
      env.stackNames.compute,
      'WebUiUrl',
    );
    webUrl = domain ? domain.replace(/\/+$/, '') : undefined;
  });

  it('CloudFront distribution exists and is Deployed', async () => {
    if (!distributionId) {
      // Some upstream versions only publish the URL, not the ID. Skip if so.
      return;
    }
    const client = new CloudFrontClient({ region: 'us-east-1' });
    const response = await client.send(
      new GetDistributionCommand({ Id: distributionId }),
    );
    expect(response.Distribution?.Status).toBe('Deployed');
    expect(response.Distribution?.DistributionConfig?.Enabled).toBe(true);
  });

  it('root URL returns 200 with HTML', async () => {
    if (!webUrl) {
      throw new Error(
        `Compute stack does not publish a WebUiUrl output. ` +
          `Update this test with the correct output key.`,
      );
    }
    const response = await fetch(webUrl, { redirect: 'follow' });
    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/text\/html/);
    const body = await response.text();
    // The Vite-built SPA includes a <div id="root"> mount point.
    expect(body).toMatch(/<div id="root"|<div id="app"/);
  });
});
