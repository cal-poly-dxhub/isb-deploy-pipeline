/**
 * Jest is configured with two projects:
 *
 *   - "unit"        : fast, hermetic tests in test/. No AWS calls.
 *                     Runs on every commit/PR via `npm test`.
 *
 *   - "integration" : tests in test/integration/ that require real AWS
 *                     credentials and a deployed Innovation Sandbox install.
 *                     Run via `npm run test:integration` after a deploy.
 *
 * The pipeline's IntegrationTest CodeBuild step invokes the integration
 * project after Compute deploys, with credentials assumed in the hub account.
 */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      roots: ['<rootDir>/test'],
      testMatch: ['<rootDir>/test/*.test.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/test/integration/'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/integration'],
      testMatch: ['<rootDir>/test/integration/**/*.int.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      moduleFileExtensions: ['ts', 'js', 'json'],
      // Integration tests set their own timeouts via jest.setTimeout() at the
      // top of each file. Defaults are too short for AWS calls.
    },
  ],
  collectCoverageFrom: ['lib/**/*.ts', '!lib/**/*.d.ts'],
};
