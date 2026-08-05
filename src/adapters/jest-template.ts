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
 * Jest globalSetup (template mode).
 *
 * ```js
 * // jest.cedar-global.cjs
 * const { createGlobalSetup } = require("@cedarjs/pg/jest/template");
 * module.exports = createGlobalSetup({ migrate: async ({ databaseUrl }) => {} });
 *
 * // jest.config.cjs
 * globalSetup: "<rootDir>/jest.cedar-global.cjs",
 * globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
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
