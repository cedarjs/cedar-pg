/**
 * TEMPLATE mode, two test files in one worker (`--runInBand` → JEST_WORKER_ID=1).
 * Jest gives each file a fresh globalThis + module registry, so the second file's
 * cloneWorkerDatabase() must reuse <tmpl>_c_1 in Postgres, not CREATE it again.
 * @type {import('jest').Config}
 */
module.exports = {
  testMatch: ["**/jest-template*.test.cjs"],
  globalSetup: "<rootDir>/jest-template.global.cjs",
  globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
};
