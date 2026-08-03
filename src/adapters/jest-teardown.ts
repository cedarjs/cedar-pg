import { dispose } from "../core/lifecycle.ts";

/**
 * Jest `globalTeardown` entry (default export).
 *
 * ```js
 * globalTeardown: require.resolve('@cedarjs/pg/jest-teardown')
 * ```
 *
 * Lease-gated dispose; no skip re-check (env may flip mid-suite).
 */
export default async function teardown(): Promise<void> {
  await dispose({ mode: "test" });
}
