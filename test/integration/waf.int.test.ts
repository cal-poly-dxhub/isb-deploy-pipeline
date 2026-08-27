/**
 * WAF web ACL tests.
 *
 * The architecture diagram shows AWS WAF protecting the API Gateway. A WAF
 * that fails to be attached is a silent security regression — requests still
 * succeed, they just no longer go through any rule evaluation. We catch that
 * by asserting:
 *
 *   1. A WAF web ACL with the expected name exists in the regional scope.
 *   2. It has at least one rule (an empty ACL is functionally a no-op).
 *   3. Some resource is associated with it.
 *
 * NOTE: API Gateway WAF associations are REGIONAL scope, not CLOUDFRONT
 * scope. CloudFront WAFs would need a separate test in us-east-1.
 */
import {
  GetWebACLCommand,
  ListResourcesForWebACLCommand,
  ListWebACLsCommand,
  WAFV2Client,
} from '@aws-sdk/client-wafv2';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('WAF web ACL', () => {
  const client = new WAFV2Client({ region: env.hubRegion });

  let webAclId: string | undefined;
  let webAclName: string | undefined;

  beforeAll(async () => {
    const response = await client.send(
      new ListWebACLsCommand({ Scope: 'REGIONAL' }),
    );
    const acl = response.WebACLs?.find((a) =>
      (a.Name ?? '').toLowerCase().includes('isb') ||
      (a.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    webAclId = acl?.Id;
    webAclName = acl?.Name;
  });

  it('a regional web ACL exists for InnovationSandbox', () => {
    expect(webAclId).toBeDefined();
    expect(webAclName).toBeDefined();
  });

  it('web ACL has at least one rule', async () => {
    if (!webAclId || !webAclName) return;
    const response = await client.send(
      new GetWebACLCommand({
        Id: webAclId,
        Name: webAclName,
        Scope: 'REGIONAL',
      }),
    );
    const ruleCount = response.WebACL?.Rules?.length ?? 0;
    expect(ruleCount).toBeGreaterThan(0);
  });

  it('web ACL is associated with at least one API Gateway stage', async () => {
    if (!webAclId || !webAclName) return;
    const response = await client.send(
      new ListResourcesForWebACLCommand({
        WebACLArn: await getWebAclArn(client, webAclId, webAclName),
        ResourceType: 'API_GATEWAY',
      }),
    );
    expect((response.ResourceArns ?? []).length).toBeGreaterThan(0);
  });
});

async function getWebAclArn(
  client: WAFV2Client,
  id: string,
  name: string,
): Promise<string> {
  const response = await client.send(
    new GetWebACLCommand({ Id: id, Name: name, Scope: 'REGIONAL' }),
  );
  if (!response.WebACL?.ARN) {
    throw new Error(`WebACL ${name} returned no ARN`);
  }
  return response.WebACL.ARN;
}
