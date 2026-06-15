/**
 * AppConfig smoke tests.
 *
 * The Compute stack defines a hosted configuration for solution-wide
 * parameters (lease preferences, terms of service, auth config). We verify
 * the application + environment + latest deployment are all in a good state.
 */
import {
  AppConfigClient,
  ListApplicationsCommand,
  ListDeploymentsCommand,
  ListEnvironmentsCommand,
} from '@aws-sdk/client-appconfig';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('AppConfig', () => {
  const client = new AppConfigClient({ region: env.hubRegion });

  it('has an application named for the solution', async () => {
    const response = await client.send(new ListApplicationsCommand({}));
    const app = response.Items?.find((a) =>
      (a.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    expect(app).toBeDefined();
    expect(app?.Id).toBeDefined();
  });

  it('latest deployment in every environment is COMPLETE', async () => {
    const apps = await client.send(new ListApplicationsCommand({}));
    const app = apps.Items?.find((a) =>
      (a.Name ?? '').toLowerCase().includes('innovationsandbox'),
    );
    if (!app?.Id) {
      throw new Error('No InnovationSandbox AppConfig application found');
    }
    const envs = await client.send(
      new ListEnvironmentsCommand({ ApplicationId: app.Id }),
    );
    expect(envs.Items?.length).toBeGreaterThan(0);

    for (const appEnv of envs.Items ?? []) {
      if (!appEnv.Id) continue;
      const deployments = await client.send(
        new ListDeploymentsCommand({
          ApplicationId: app.Id,
          EnvironmentId: appEnv.Id,
        }),
      );
      const latest = deployments.Items?.[0];
      if (!latest) continue;
      // COMPLETE is good. BAKING / DEPLOYING right after a deploy are also
      // acceptable - this test runs immediately after a deploy.
      expect(['COMPLETE', 'BAKING', 'DEPLOYING']).toContain(latest.State);
    }
  });
});
