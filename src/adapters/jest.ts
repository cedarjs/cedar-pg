import { dispose, ensureIfNeeded } from "../core/lifecycle.ts";

/**
 * Jest globalSetup. Call from jest config:
 * ```js
 * globalSetup: require.resolve('@cedarjs/pg/jest')
 * ```
 * Pair with `teardown` from this module as globalTeardown.
 */
export default async function globalSetup(): Promise<void> {
  await ensureIfNeeded({
    mode: "test",
    setEnv: true,
  });
}

/** Lease-gated dispose; no skip re-check (env may flip mid-suite). */
export async function teardown(): Promise<void> {
  await dispose({ mode: "test" });
}
