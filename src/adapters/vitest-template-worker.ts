import { ensureWorkerDatabase } from "./template-mode.ts";

/**
 * Vitest per-worker helper. Prefer a local ESM setupFiles entry:
 *
 * ```ts
 * // vitest.cedar-worker.ts
 * import { ensureWorkerDatabase } from "@cedarjs/pg/vitest/template/worker";
 * await ensureWorkerDatabase();
 * ```
 *
 * (No top-level await here — pack emits CJS + ESM.)
 */
export { ensureWorkerDatabase };
export default ensureWorkerDatabase;
