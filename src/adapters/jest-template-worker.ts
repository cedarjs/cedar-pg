import { ensureWorkerDatabase, setupTemplateWorker } from "./template-mode.ts";

export { ensureWorkerDatabase, setupTemplateWorker };

/**
 * Jest per-worker helper. Prefer setupFilesAfterEnv:
 *
 * ```js
 * // jest.cedar-worker.cjs
 * const { ensureWorkerDatabase } = require("@cedarjs/pg/jest/template/worker");
 * beforeAll(() => ensureWorkerDatabase());
 * ```
 */
export default ensureWorkerDatabase;
