/**
 * Optional command-string builders for Nx `project.json` targets. You can write
 * the same strings by hand.
 *
 * Nx `dependsOn` does not forward env from one target to another. So one
 * `db:ready` target acquires + migrates (`cedarPgRunCommand`, the only DDL), and
 * children either preload `@cedarjs/pg/dev-env` or wrap with attach-only
 * `cedarpg run --attach` (`cedarPgAttachCommand`). Never acquire in a child.
 */

import { CLI_NAME } from "../core/constants.ts";
import type { DbMode } from "../core/naming.ts";

/** Acquire + exec (`cedarpg run`). Use only for the single `db:ready` target. */
export function cedarPgRunCommand(mode: DbMode, command: string, bin = CLI_NAME): string {
  return `${bin} run --mode=${mode} -- ${command}`;
}

/** Attach-only exec (`cedarpg run --attach`): lease env, no DDL. Use for children of `db:ready`. */
export function cedarPgAttachCommand(mode: DbMode, command: string, bin = CLI_NAME): string {
  return `${bin} run --attach --mode=${mode} -- ${command}`;
}
