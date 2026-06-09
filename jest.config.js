/**
 * Jest is configured with three projects:
 *
 *   - "unit"        : fast, hermetic tests in test/. No AWS calls.
 *                     Runs on every commit/PR via `npm test`.
 *
 *   - "integration" : tests in test/integration/ that require real AWS
 *                     credentials and a deployed Innovation Sandbox install.
 *                     Run via `npm run test:integration` after a deploy.
 *
 *   - "functional"  : end-to-end tests that create/terminate leases and
 *                     exercise the full lifecycle. Gated on RUN_FUNCTIONAL_TESTS=true.
 *                     Run via `npm run test:functional`.
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
      testPathIgnorePatterns: ['/node_modules/', '/test/integration/', '/test/functional/'],
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
    },
    {
      displayName: 'functional',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/functional'],
      testMatch: ['<rootDir>/test/functional/**/*.func.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
  ],
  collectCoverageFrom: ['lib/**/*.ts', '!lib/**/*.d.ts'],
};
