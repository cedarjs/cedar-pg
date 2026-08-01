/**
 * Nx target command hints. Wire into project.json / package.json:
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
 *
 * Prefer the CLI for ensure/dispose — there is no separate Nx runtime wrapper.
 */

import { cedarPgCommands } from "./tasks.ts";

/** Suggested target definitions for project.json / package.json nx targets. */
export function nxTargetHints(bin = "cedar-pg"): Record<string, { command: string }> {
  const cmds = cedarPgCommands(bin);
  return {
    "db:ensure": { command: cmds.ensureDev },
    "db:ensure-test": { command: cmds.ensureTest },
    "db:dispose-test": { command: cmds.disposeTest },
  };
}
