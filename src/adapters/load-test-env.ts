import { existsSync, readFileSync } from "node:fs";
import { envPath, leasePath } from "../core/lease.ts";
import { resolveRoot } from "../core/worktree.ts";

/**
 * Load `.cedarpg/test.env` into `process.env` (worker-side).
 *
 * Jest (and optional Vitest `setupFiles`) run tests in a different process than
 * `globalSetup`, so `setEnv` in ensure does not reach workers — the env file does.
 *
 * No-ops unless a matching `test.json` lease exists, so a leftover env after dispose
 * cannot inject a dropped DATABASE_URL.
 */
export function loadTestEnv(root?: string): void {
  const resolved = resolveRoot(root);
  if (!existsSync(leasePath(resolved, "test"))) return;

  const file = envPath(resolved, "test");
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
