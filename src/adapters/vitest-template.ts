import {
  ensureWorkerDatabase,
  resolveMigrateFromEnv,
  setupTemplateMode,
  setupTemplateWorker,
  teardownTemplateMode,
  type SetupTemplateModeOptions,
} from "./template-mode.ts";

export {
  ensureWorkerDatabase,
  setupTemplateMode,
  setupTemplateWorker,
  teardownTemplateMode as teardown,
};

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
 * Set `CEDAR_PG_MIGRATE` or use `createSetup({ migrate })`.
 */
export async function setup(): Promise<() => Promise<void>> {
  const migrate = await resolveMigrateFromEnv();
  return runSetup({ migrate });
}

export function createSetup(options: SetupTemplateModeOptions = {}) {
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
