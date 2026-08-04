/**
 * Nx targets. `dependsOn` does not forward ensure env (unlike Vite+ `env: [...]`);
 * wrap children with `cedarpg run`, or set `envFile` to `.cedarpg/<mode>.env`.
 *
 * ```json
 * {
 *   "targets": {
 *     "dev": {
 *       "command": "cedarpg run --mode=dev -- yarn tsx scripts/apiServer/dev.ts"
 *     },
 *     "db:ensure": { "command": "cedarpg ensure --mode=dev" },
 *     "serve": {
 *       "dependsOn": ["db:ensure"],
 *       "command": "node dist/server.js",
 *       "options": { "envFile": ".cedarpg/dev.env" }
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
  CEDAR_PG_TASK_ENSURE_DEV,
  CEDAR_PG_TASK_ENSURE_TEST,
} from "./tasks.ts";

export {
  CEDAR_PG_TASK_ENSURE_DEV as CEDAR_PG_NX_ENSURE_DEV,
  CEDAR_PG_TASK_ENSURE_TEST as CEDAR_PG_NX_ENSURE_TEST,
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
