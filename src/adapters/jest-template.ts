import {
  cloneWorkerDatabase,
  setupTemplateMode,
  type SetupTemplateModeOptions,
} from "./template-mode.ts";

export { cloneWorkerDatabase };
export type {
  SetupTemplateModeOptions,
  TemplateMigrateFn,
  TemplateMigrateContext,
} from "./template-mode.ts";

/**
 * Jest globalSetup (template mode). Drops crashed-run leftovers under this
 * worktree's test role, then acquire → migrate → markTemplate.
 *
 * ```js
 * // jest.cedar-global.cjs
 * const { createGlobalSetup } = require("@cedarjs/pg/jest/template");
 * module.exports = createGlobalSetup({ migrate: async ({ databaseUrl }) => {} });
 *
 * // jest.config.cjs
 * // When .env has a real TEST_DATABASE_URL, set once here (inherits to workers):
 * // process.env.CEDAR_PG_FORCE = "1";
 * globalSetup: "<rootDir>/jest.cedar-global.cjs",
 * globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
 * // Runs per test file; every file in a worker reuses that worker's clone.
 * setupFilesAfterEnv: ["<rootDir>/jest.cedar-worker.cjs"],
 *
 * // jest.cedar-worker.cjs
 * const { cloneWorkerDatabase } = require("@cedarjs/pg/jest/template");
 * beforeAll(() => cloneWorkerDatabase());
 * ```
 *
 * Stock `@cedarjs/pg/jest` is one shared test DB only.
 */
export function createGlobalSetup(options: SetupTemplateModeOptions) {
  return async () => {
    await setupTemplateMode(options);
  };
}

/** String `require.resolve` without a migrate hook is unsupported — use `createGlobalSetup`. */
export default async function globalSetup(): Promise<void> {
  throw new Error(
    "@cedarjs/pg/jest/template requires createGlobalSetup({ migrate }). " +
      "Point globalSetup at a local module that exports createGlobalSetup({ migrate }).",
  );
}
