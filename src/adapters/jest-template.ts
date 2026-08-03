import {
  createTemplateGlobalSetup,
  requireMigrateFromEnv,
  setupTemplateMode,
  type SetupTemplateModeOptions,
} from "./template-mode.ts";

/**
 * Jest globalSetup (template mode).
 *
 * ```js
 * globalSetup: require.resolve("@cedarjs/pg/jest/template"),
 * globalTeardown: require.resolve("@cedarjs/pg/jest/template/teardown"),
 * setupFilesAfterEnv: ["<rootDir>/jest.cedar-worker.cjs"],
 * ```
 *
 * Requires `CEDAR_PG_MIGRATE` or `createGlobalSetup({ migrate })`.
 * Stock `@cedarjs/pg/jest` is one shared test DB only.
 */
export default async function globalSetup(): Promise<void> {
  await setupTemplateMode({ migrate: await requireMigrateFromEnv() });
}

/** Build a Jest globalSetup with an in-process migrate hook. */
export function createGlobalSetup(options: SetupTemplateModeOptions) {
  return createTemplateGlobalSetup(options);
}
