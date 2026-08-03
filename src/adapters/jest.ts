import { ensureIfNeeded } from "../core/lifecycle.ts";

/**
 * Jest globalSetup. Call from jest config:
 * ```js
 * globalSetup: require.resolve('@cedarjs/pg/jest'),
 * globalTeardown: require.resolve('@cedarjs/pg/jest-teardown'),
 * setupFiles: [require.resolve('@cedarjs/pg/test-env')],
 * ```
 *
 * `setupFiles` is required: Jest runs globalSetup in a separate process, so
 * `DATABASE_URL` reaches workers via `.cedarpg/test.env`.
 */
export default async function globalSetup(): Promise<void> {
  await ensureIfNeeded({
    mode: "test",
    setEnv: true,
  });
}
