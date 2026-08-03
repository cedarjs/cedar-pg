import {
  createTemplateGlobalSetup,
  ensureWorkerDatabase,
  resolveMigrateFromEnv,
  setupTemplateMode,
  setupTemplateWorker,
  teardownTemplateMode,
} from "./template-mode.ts";

export {
  createTemplateGlobalSetup as createGlobalSetup,
  ensureWorkerDatabase,
  setupTemplateMode,
  setupTemplateWorker,
  teardownTemplateMode as teardown,
};

/**
 * Jest globalSetup (template mode).
 *
 * ```js
 * globalSetup: require.resolve("@cedarjs/pg/jest/template"),
 * globalTeardown: require.resolve("@cedarjs/pg/jest/template/teardown"),
 * setupFilesAfterEnv: ["<rootDir>/jest.cedar-worker.cjs"],
 * ```
 *
 * Migrate via `CEDAR_PG_MIGRATE` (module exporting `migrate` or default) or
 * `createGlobalSetup({ migrate })`. Stock `@cedarjs/pg/jest` is one shared test DB only.
 */
export default async function globalSetup(): Promise<void> {
  const migrate = await resolveMigrateFromEnv();
  await setupTemplateMode({ migrate });
}
