import { ensureIfNeeded } from "../core/lifecycle.ts";

/**
 * Vitest globalSetup: ensure test DB, return teardown that disposes it.
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
  const result = await ensureIfNeeded({
    mode: "test",
    setEnv: true,
  });
  if (result.status !== "ensured") {
    return async () => {};
  }
  return async () => {
    await result.dispose();
  };
}
