import { loadTestEnv } from "./load-test-env.ts";

/**
 * Test-runner `setupFiles` entry: inject `DATABASE_URL` from `.cedarpg/test.env`.
 *
 * Required for Jest (globalSetup is a separate process). Optional for Vitest
 * when the pool does not inherit env from the main process.
 *
 * ```js
 * setupFiles: [require.resolve('@cedarjs/pg/test-env')]
 * // or: setupFiles: ['@cedarjs/pg/test-env']
 * ```
 */
loadTestEnv();
