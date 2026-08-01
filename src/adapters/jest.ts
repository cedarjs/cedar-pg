import { ensure, dispose } from "../core/lifecycle.ts";

/**
 * Jest globalSetup — call from jest config:
 * ```js
 * globalSetup: require.resolve('cedar-pg/jest')
 * ```
 * Pair with globalTeardown from the same module's teardown export,
 * or use the returned pattern via a thin wrapper.
 *
 * Jest expects default export async function for globalSetup.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.CEDAR_PG === "0" || process.env.CEDAR_PG === "false") {
    return;
  }
  if (process.env.TEST_DATABASE_URL && process.env.CEDAR_PG_FORCE !== "1") {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    return;
  }

  await ensure({
    mode: "test",
    disposeOnExit: false,
    setEnv: true,
  });
}

export async function teardown(): Promise<void> {
  if (process.env.CEDAR_PG === "0" || process.env.CEDAR_PG === "false") {
    return;
  }
  if (process.env.TEST_DATABASE_URL && process.env.CEDAR_PG_FORCE !== "1") {
    return;
  }
  await dispose({ mode: "test" });
}
