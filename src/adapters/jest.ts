import { acquireIfNeeded } from "../core/lifecycle.ts";

/**
 * Jest globalSetup for a single shared test DB (`acquireIfNeeded` + dispose).
 * Not a migrate-once / per-worker TEMPLATE runner — use `@cedarjs/pg/jest/template`.
 *
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
  await acquireIfNeeded({
    mode: "test",
    setEnv: true,
  });
}
