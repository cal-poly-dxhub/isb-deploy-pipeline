/**
 * v1.3 AppConfig smoke tests.
 *
 * v1.3 moves general settings to DynamoDB but intentionally retains the
 * AppConfig application for the Nuke and validator-exclusion profiles. The
 * Data stack outputs are the authoritative resource IDs, so discovery does
 * not depend on the application display name.
 */
import {
  AppConfigClient,
  GetApplicationCommand,
  ListDeploymentsCommand,
} from "@aws-sdk/client-appconfig";

import { loadIntegrationEnv, requireStackOutput } from "./support/test-env";

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe("AppConfig v1.3 cleanup configuration", () => {
  const client = new AppConfigClient({ region: env.hubRegion });

  async function configIds() {
    return {
      applicationId: await requireStackOutput(
        env.hubRegion,
        env.stackNames.data,
        "ConfigApplicationId",
      ),
      environmentId: await requireStackOutput(
        env.hubRegion,
        env.stackNames.data,
        "ConfigEnvironmentId",
      ),
    };
  }

  it("retains the AppConfig application used by cleanup configuration", async () => {
    const { applicationId } = await configIds();
    const response = await client.send(
      new GetApplicationCommand({ ApplicationId: applicationId }),
    );
    expect(response.Id).toBe(applicationId);
    expect(response.Name).toBe(`${env.namespace}-Config-Application`);
  });

  it("has a deployed cleanup configuration", async () => {
    const { applicationId, environmentId } = await configIds();
    const response = await client.send(
      new ListDeploymentsCommand({
        ApplicationId: applicationId,
        EnvironmentId: environmentId,
      }),
    );
    expect(response.Items?.length).toBeGreaterThan(0);
    const latest = response.Items?.[0];
    expect(["COMPLETE", "BAKING", "DEPLOYING"]).toContain(latest?.State);
  });
});
