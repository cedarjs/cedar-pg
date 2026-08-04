import {
  ensureWorkerDatabase,
  setupTemplateMode,
  type SetupTemplateModeOptions,
} from "./template-mode.ts";

export { ensureWorkerDatabase };
export type {
  SetupTemplateModeOptions,
  TemplateMigrateFn,
  TemplateMigrateContext,
} from "./template-mode.ts";

/**
 * Vitest globalSetup (template mode). Returns teardown that disposes TEMPLATE + clones.
 *
 * ```ts
 * // vitest.cedar-global.ts
 * import { createGlobalSetup } from "@cedarjs/pg/vitest/template";
 * export default createGlobalSetup({ migrate: async ({ databaseUrl }) => {} });
 *
 * // vitest.config.ts
 * export default defineConfig({
 *   test: {
 *     globalSetup: ["./vitest.cedar-global.ts"],
 *     setupFiles: ["./vitest.cedar-worker.ts"],
 *   },
 * })
 *
 * // vitest.cedar-worker.ts — local ESM (pack emits CJS+ESM; top-level await lives here)
 * import { ensureWorkerDatabase } from "@cedarjs/pg/vitest/template";
 * await ensureWorkerDatabase();
 * ```
 *
 * Stock `@cedarjs/pg/vitest` is one shared test DB only.
 */
export function createGlobalSetup(options: SetupTemplateModeOptions) {
  return async () => {
    const result = await setupTemplateMode(options);
    if (result.status !== "ensured") {
      return async () => {};
    }
    return async () => {
      await result.dispose();
    };
  };
}

/** String path without a migrate hook is unsupported — use `createGlobalSetup`. */
export default async function setup(): Promise<() => Promise<void>> {
  throw new Error(
    "@cedarjs/pg/vitest/template requires createGlobalSetup({ migrate }). " +
      "Point globalSetup at a local module that exports createGlobalSetup({ migrate }).",
  );
}
