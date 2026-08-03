import {
  requireMigrateFromEnv,
  setupTemplateMode,
  teardownTemplateMode,
  type SetupTemplateModeOptions,
} from "./template-mode.ts";

/**
 * Vitest globalSetup (template mode). Returns teardown that disposes TEMPLATE + clones.
 *
 * ```ts
 * export default defineConfig({
 *   test: {
 *     globalSetup: ["@cedarjs/pg/vitest/template"],
 *     setupFiles: ["@cedarjs/pg/vitest/template/worker"],
 *   },
 * })
 * ```
 *
 * Requires `CEDAR_PG_MIGRATE` or `createGlobalSetup({ migrate })`.
 */
export async function setup(): Promise<() => Promise<void>> {
  return runSetup({ migrate: await requireMigrateFromEnv() });
}

/** Build a Vitest globalSetup with an in-process migrate hook. */
export function createGlobalSetup(options: SetupTemplateModeOptions) {
  return async () => runSetup(options);
}

async function runSetup(options: SetupTemplateModeOptions): Promise<() => Promise<void>> {
  const result = await setupTemplateMode(options);
  if (result.status !== "ensured") {
    return async () => {};
  }
  const root = result.root;
  return async () => {
    await teardownTemplateMode({ root });
  };
}

export default setup;
