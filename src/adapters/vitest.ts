import { ensure } from "../core/lifecycle.ts";

/**
 * Vitest globalSetup — ensure test DB, return teardown that disposes it.
 *
 * vitest.config.ts:
 * ```ts
 * export default defineConfig({
 *   test: {
 *     globalSetup: ['cedar-pg/vitest'],
 *   },
 * })
 * ```
 */
export async function setup(): Promise<() => Promise<void>> {
  if (process.env.CEDAR_PG === "0" || process.env.CEDAR_PG === "false") {
    return async () => {};
  }
  // Honor explicit TEST_DATABASE_URL escape hatch
  if (process.env.TEST_DATABASE_URL && process.env.CEDAR_PG_FORCE !== "1") {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    return async () => {};
  }

  const result = await ensure({
    mode: "test",
    disposeOnExit: false,
    setEnv: true,
  });

  return async () => {
    await result.dispose();
  };
}

export default setup;
