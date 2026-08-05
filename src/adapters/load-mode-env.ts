import { existsSync, readFileSync } from "node:fs";
import { envPath, leasePath } from "../core/lease.ts";
import type { DbMode } from "../core/naming.ts";
import { resolveRoot } from "../core/worktree.ts";

export type LoadModeEnvOptions = {
  root?: string;
  /** Overwrite existing `process.env` keys (default: only fill undefined). */
  overwrite?: boolean;
};

export function normalizeLoadOptions(
  rootOrOptions?: string | LoadModeEnvOptions,
): LoadModeEnvOptions {
  if (typeof rootOrOptions === "string" || rootOrOptions === undefined) {
    return { root: rootOrOptions };
  }
  return rootOrOptions;
}

/** Load `.cedarpg/<mode>.env` when a matching lease exists; no-op if stale/missing. */
export function loadModeEnv(mode: DbMode, options: LoadModeEnvOptions = {}): void {
  const resolved = resolveRoot(options.root);
  if (!existsSync(leasePath(resolved, mode))) return;

  const file = envPath(resolved, mode);
  if (!existsSync(file)) return;

  const overwrite = options.overwrite === true;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (overwrite || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
