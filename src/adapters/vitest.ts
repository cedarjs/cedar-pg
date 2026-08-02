import { ensureIfNeeded } from "../core/lifecycle.ts";

/**
 * Vitest globalSetup — ensure test DB, return teardown that disposes it.
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
export async function setup(): Promise<() => Promise<void>> {
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

export default setup;
