import { ensureWorkerDatabase, setupTemplateWorker } from "./template-mode.ts";

export { ensureWorkerDatabase, setupTemplateWorker };

/**
 * Vitest setupFiles entry — clones once per worker process and sets DATABASE_URL.
 * Uses top-level await (ESM).
 */
await ensureWorkerDatabase();

export default ensureWorkerDatabase;
