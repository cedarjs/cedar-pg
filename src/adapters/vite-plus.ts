/**
 * Consumer adapter for external Vite+ projects.
 *
 * Merge into `vite.config.ts` `run.tasks` so `vp run test` / `vp run dev`
 * depend on cedarpg ensure.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vite-plus'
 * import { cedarPgTasks } from '@cedarjs/pg/vite-plus'
 *
 * export default defineConfig({
 *   run: {
 *     tasks: {
 *       ...cedarPgTasks(),
 *       test: {
 *         command: 'vp test',
 *         dependsOn: ['db:ensure-test'],
 *         env: ['DATABASE_URL', 'TEST_DATABASE_URL'],
 *       },
 *       dev: {
 *         command: 'vp dev',
 *         dependsOn: ['db:ensure'],
 *         env: ['DATABASE_URL'],
 *       },
 *     },
 *   },
 * })
 * ```
 */

import { CLI_NAME } from "../core/constants.ts";
import { cedarPgCommands } from "./tasks.ts";

export const CEDAR_PG_TASK_ENSURE_DEV = "db:ensure";
export const CEDAR_PG_TASK_ENSURE_TEST = "db:ensure-test";
export const CEDAR_PG_TASK_DISPOSE_TEST = "db:dispose-test";

export type CedarPgTaskDef = {
  command: string;
  cache?: boolean;
};

export type CedarPgTasksOptions = {
  /** Binary name / path (default: CLI_NAME / `cedarpg`). */
  bin?: string;
  /** Include dispose-test task (default: true). */
  includeDisposeTest?: boolean;
};

/**
 * Returns Vite+ `run.tasks` entries for cedar-pg lifecycle.
 */
export function cedarPgTasks(options: CedarPgTasksOptions = {}): Record<string, CedarPgTaskDef> {
  const cmds = cedarPgCommands(options.bin ?? CLI_NAME);
  const tasks: Record<string, CedarPgTaskDef> = {
    [CEDAR_PG_TASK_ENSURE_DEV]: {
      command: cmds.ensureDev,
      cache: false,
    },
    [CEDAR_PG_TASK_ENSURE_TEST]: {
      command: cmds.ensureTest,
      cache: false,
    },
  };
  if (options.includeDisposeTest !== false) {
    tasks[CEDAR_PG_TASK_DISPOSE_TEST] = {
      command: cmds.disposeTest,
      cache: false,
    };
  }
  return tasks;
}
