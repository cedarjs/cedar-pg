import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leaseDir } from "../core/lease.ts";
import { resolveRoot } from "../core/worktree.ts";

/**
 * Load `.cedarpg/test.env` into `process.env` (worker-side).
 *
 * Jest (and optional Vitest `setupFiles`) run tests in a different process than
 * `globalSetup`, so `setEnv` in ensure does not reach workers — the env file does.
 */
export function loadTestEnv(root?: string): void {
  const envPath = join(leaseDir(resolveRoot(root)), "test.env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
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
