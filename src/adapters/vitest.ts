import { acquireIfNeeded } from "../core/lifecycle.ts";

/**
 * Vitest globalSetup for a single shared test DB.
 * Not a migrate-once / per-worker TEMPLATE runner — use `@cedarjs/pg/vitest/template`.
 *
 * Vitest runs globalSetup in the main process then spawns workers, so
 * `process.env` mutations (via `setEnv`) are inherited. Pair with
 * `setupFiles: ['@cedarjs/pg/test-env']` only if your pool does not inherit env.
 *
 * vitest.config.ts:
 * ```ts
 * export default defineConfig({
 *   test: {
 *     globalSetup: ['@cedarjs/pg/vitest'],
 *   },
 * })
 * ```
 */
export default async function setup(): Promise<() => Promise<void>> {
  const result = await acquireIfNeeded({
    mode: "test",
    setEnv: true,
  });
  if (result.status !== "acquired") {
    return async () => {};
  }
  return async () => {
    await result.dispose();
  };
}
