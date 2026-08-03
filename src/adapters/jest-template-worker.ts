import { ensureWorkerDatabase } from "./template-mode.ts";

/**
 * Jest per-worker helper. Prefer setupFilesAfterEnv:
 *
 * ```js
 * // jest.cedar-worker.cjs
 * const { ensureWorkerDatabase } = require("@cedarjs/pg/jest/template/worker");
 * beforeAll(() => ensureWorkerDatabase());
 * ```
 */
export { ensureWorkerDatabase };
export default ensureWorkerDatabase;
