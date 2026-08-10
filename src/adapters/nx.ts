/**
 * Nx targets. `dependsOn` does not forward acquire env (unlike Vite+ `env: [...]`).
 * Canonical shape: `createAcquireTask` / `db:ready`, then wrap children with
 * `cedarpg run --mode=dev --force -- <cmd>`. Avoid concurrent acquire/run on the
 * same worktree. Secondary: `envFile` → `.cedarpg/<mode>.env` (still loses to
 * ambient `.env` without force/overwrite).
 *
 * ```json
 * {
 *   "targets": {
 *     "db:ready": { "command": "tsx tools/db-ready.ts", "cache": false },
 *     "dev": {
 *       "dependsOn": ["db:ready"],
 *       "command": "cedarpg run --mode=dev --force -- yarn tsx scripts/apiServer/dev.ts"
 *     }
 *   }
 * }
 * ```
 */

import { CLI_NAME, STATE_DIRNAME } from "../core/constants.ts";
import { envFilePath } from "../core/lease.ts";
import type { DbMode } from "../core/naming.ts";
import {
  cedarPgLifecycleTargets,
  cedarPgRunCommand,
  type CedarPgLifecycleTarget,
  type CedarPgLifecycleTargetsOptions,
  CEDAR_PG_TASK_DISPOSE_TEST,
  CEDAR_PG_TASK_ACQUIRE_DEV,
  CEDAR_PG_TASK_ACQUIRE_TEST,
} from "./tasks.ts";

export {
  CEDAR_PG_TASK_ACQUIRE_DEV as CEDAR_PG_NX_ACQUIRE_DEV,
  CEDAR_PG_TASK_ACQUIRE_TEST as CEDAR_PG_NX_ACQUIRE_TEST,
  CEDAR_PG_TASK_DISPOSE_TEST as CEDAR_PG_NX_DISPOSE_TEST,
  cedarPgLifecycleTargets as cedarPgNxTargets,
  cedarPgRunCommand,
  envFilePath,
};

/** Relative path for Nx `envFile` / dotenv. */
export function relativeEnvFile(mode: DbMode): string {
  return `${STATE_DIRNAME}/${mode}.env`;
}

export type NxTargetHint = CedarPgLifecycleTarget;
export type CedarPgNxTargetsOptions = CedarPgLifecycleTargetsOptions;

/** @deprecated Prefer `cedarPgNxTargets()`. */
export function nxTargetHints(bin = CLI_NAME): Record<string, { command: string }> {
  return Object.fromEntries(
    Object.entries(cedarPgLifecycleTargets({ bin })).map(([name, def]) => [
      name,
      { command: def.command },
    ]),
  );
}
