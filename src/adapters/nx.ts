/**
 * Nx target command hints. Wire into project.json / package.json:
 *
 * ```json
 * {
 *   "targets": {
 *     "db:ensure": { "command": "cedarpg ensure --mode=dev" },
 *     "test": {
 *       "dependsOn": ["db:ensure-test"],
 *       "command": "vitest run"
 *     }
 *   }
 * }
 * ```
 *
 * Prefer the CLI (`cedarpg` from `@cedarjs/pg`) for ensure/dispose —
 * there is no separate Nx runtime wrapper.
 */

import { CLI_NAME } from "../core/constants.ts";
import { cedarPgCommands } from "./tasks.ts";

/** Suggested target definitions for project.json / package.json nx targets. */
export function nxTargetHints(bin = CLI_NAME): Record<string, { command: string }> {
  const cmds = cedarPgCommands(bin);
  return {
    "db:ensure": { command: cmds.ensureDev },
    "db:ensure-test": { command: cmds.ensureTest },
    "db:dispose-test": { command: cmds.disposeTest },
  };
}
