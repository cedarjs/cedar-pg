import { ensureWorkerDatabase } from "./template-mode.ts";

/**
 * Import from a local ESM setupFiles file (not this module path as setupFiles):
 *
 * ```ts
 * // vitest.cedar-worker.ts
 * import { ensureWorkerDatabase } from "@cedarjs/pg/vitest/template/worker";
 * await ensureWorkerDatabase();
 * ```
 *
 * Pack emits CJS + ESM, so this file itself cannot use top-level await.
 */
export { ensureWorkerDatabase };
export default ensureWorkerDatabase;
