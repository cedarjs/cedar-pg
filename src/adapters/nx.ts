/**
 * Thin Nx-oriented helpers. Wire as an executor or target command:
 *
 * ```json
 * {
 *   "targets": {
 *     "db:ensure": { "command": "cedar-pg ensure --mode=dev" },
 *     "test": {
 *       "dependsOn": ["db:ensure-test"],
 *       "command": "vitest run"
 *     }
 *   }
 * }
 * ```
 */

import { ensure, dispose, type EnsureOptions, type EnsureResult } from "../core/lifecycle.ts";

export type NxEnsureContext = {
  projectRoot?: string;
  mode?: "dev" | "test";
};

/**
 * Nx-friendly ensure: uses project root from context when provided.
 */
export async function nxEnsure(context: NxEnsureContext = {}): Promise<EnsureResult> {
  const opts: EnsureOptions = {
    root: context.projectRoot,
    mode: context.mode ?? "dev",
  };
  return ensure(opts);
}

export async function nxDispose(context: NxEnsureContext = {}): Promise<void> {
  await dispose({
    root: context.projectRoot,
    mode: context.mode ?? "test",
  });
}

/** Suggested target definitions for project.json / package.json nx targets. */
export function nxTargetHints(bin = "cedar-pg"): Record<string, { command: string }> {
  return {
    "db:ensure": { command: `${bin} ensure --mode=dev` },
    "db:ensure-test": { command: `${bin} ensure --mode=test --print-env` },
    "db:dispose-test": { command: `${bin} dispose --mode=test` },
  };
}
