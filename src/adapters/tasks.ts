/** Shared CLI command strings and lifecycle target defs for Vite+ / Nx. */

import { CLI_NAME } from "../core/constants.ts";
import type { DbMode } from "../core/naming.ts";

export const CEDAR_PG_TASK_ENSURE_DEV = "db:ensure";
export const CEDAR_PG_TASK_ENSURE_TEST = "db:ensure-test";
export const CEDAR_PG_TASK_DISPOSE_TEST = "db:dispose-test";

export type CedarPgCommands = {
  ensureDev: string;
  ensureTest: string;
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
    ensureDev: `${bin} ensure --mode=dev`,
    ensureTest: `${bin} ensure --mode=test --print-env`,
    disposeTest: `${bin} dispose --mode=test`,
  };
}

export function cedarPgLifecycleTargets(
  options: CedarPgLifecycleTargetsOptions = {},
): Record<string, CedarPgLifecycleTarget> {
  const cmds = cedarPgCommands(options.bin ?? CLI_NAME);
  const targets: Record<string, CedarPgLifecycleTarget> = {
    [CEDAR_PG_TASK_ENSURE_DEV]: { command: cmds.ensureDev, cache: false },
    [CEDAR_PG_TASK_ENSURE_TEST]: { command: cmds.ensureTest, cache: false },
  };
  if (options.includeDisposeTest !== false) {
    targets[CEDAR_PG_TASK_DISPOSE_TEST] = { command: cmds.disposeTest, cache: false };
  }
  return targets;
}

export function cedarPgRunCommand(mode: DbMode, command: string, bin = CLI_NAME): string {
  return `${bin} run --mode=${mode} -- ${command}`;
}
