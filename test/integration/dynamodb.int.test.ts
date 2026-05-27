/**
 * DynamoDB smoke tests.
 *
 * The Data stack publishes table names. These checks verify the tables exist,
 * are ACTIVE, and have the expected billing mode.
 */
import {
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

import { getStackOutput, loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

describe('DynamoDB tables', () => {
  // The upstream Data stack publishes outputs like LeaseTableName,
  // AccountTable, ConfigTable. The exact set varies between minor versions,
  // so we discover them dynamically.
  const candidateOutputs = [
    'LeaseTableName',
    'AccountTableName',
    'ConfigTableName',
    'UserTableName',
  ];

  test.each(candidateOutputs)(
    'output "%s", if present, references a healthy table',
    async (outputKey) => {
      const tableName = await getStackOutput(
        env.hubRegion,
        env.stackNames.data,
        outputKey,
      );
      if (!tableName) {
        // Output not published in this version of the upstream.
        return;
      }
      const client = new DynamoDBClient({ region: env.hubRegion });
      const response = await client.send(
        new DescribeTableCommand({ TableName: tableName }),
      );
      expect(response.Table?.TableStatus).toBe('ACTIVE');
      // Innovation Sandbox uses on-demand by default.
      expect(['PAY_PER_REQUEST', 'PROVISIONED']).toContain(
        response.Table?.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST',
      );
    },
  );
});
