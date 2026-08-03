/** @type {import('jest').Config} */
module.exports = {
  testMatch: ["**/jest.test.cjs"],
  globalSetup: require.resolve("@cedarjs/pg/jest"),
  globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
  setupFiles: [require.resolve("@cedarjs/pg/test-env")],
};
