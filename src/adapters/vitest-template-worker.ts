import { ensureWorkerDatabase } from "./template-mode.ts";

/**
 * Vitest setupFiles entry — clones once per worker process and sets DATABASE_URL.
 * Uses top-level await (ESM).
 */
await ensureWorkerDatabase();

export { ensureWorkerDatabase };
export default ensureWorkerDatabase;
