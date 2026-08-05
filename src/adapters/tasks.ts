/** Shared CLI command strings and lifecycle target defs for Vite+ / Nx. */

import { CLI_NAME } from "../core/constants.ts";
import type { DbMode } from "../core/naming.ts";

export const CEDAR_PG_TASK_ACQUIRE_DEV = "db:acquire";
export const CEDAR_PG_TASK_ACQUIRE_TEST = "db:acquire-test";
export const CEDAR_PG_TASK_DISPOSE_TEST = "db:dispose-test";

export type CedarPgCommands = {
  acquireDev: string;
  acquireTest: string;
  disposeTest: string;
};

export type CedarPgLifecycleTarget = {
  command: string;
  cache?: boolean;
};

export type CedarPgLifecycleTargetsOptions = {
  bin?: string;
  /** Include dispose-test target (default: true). */
  includeDisposeTest?: boolean;
};

export function cedarPgCommands(bin = CLI_NAME): CedarPgCommands {
  return {
    acquireDev: `${bin} acquire --mode=dev`,
    acquireTest: `${bin} acquire --mode=test --print-env`,
    disposeTest: `${bin} dispose --mode=test`,
  };
}

export function cedarPgLifecycleTargets(
  options: CedarPgLifecycleTargetsOptions = {},
): Record<string, CedarPgLifecycleTarget> {
  const cmds = cedarPgCommands(options.bin ?? CLI_NAME);
  const targets: Record<string, CedarPgLifecycleTarget> = {
    [CEDAR_PG_TASK_ACQUIRE_DEV]: { command: cmds.acquireDev, cache: false },
    [CEDAR_PG_TASK_ACQUIRE_TEST]: { command: cmds.acquireTest, cache: false },
  };
  if (options.includeDisposeTest !== false) {
    targets[CEDAR_PG_TASK_DISPOSE_TEST] = { command: cmds.disposeTest, cache: false };
  }
  return targets;
}

export function cedarPgRunCommand(mode: DbMode, command: string, bin = CLI_NAME): string {
  return `${bin} run --mode=${mode} -- ${command}`;
}
