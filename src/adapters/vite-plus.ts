/**
 * Consumer adapter for external Vite+ projects.
 *
 * Merge into `vite.config.ts` `run.tasks` so `vp run test` / `vp run dev`
 * depend on cedar-pg ensure.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vite-plus'
 * import { cedarPgTasks } from 'cedar-pg/vite-plus'
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

export const CEDAR_PG_TASK_ENSURE_DEV = "db:ensure";
export const CEDAR_PG_TASK_ENSURE_TEST = "db:ensure-test";
export const CEDAR_PG_TASK_DISPOSE_TEST = "db:dispose-test";

export type CedarPgTaskDef = {
  command: string;
  cache?: boolean;
};

export type CedarPgTasksOptions = {
  /** Binary name / path (default: `cedar-pg`). */
  bin?: string;
  /** Include dispose-test task (default: true). */
  includeDisposeTest?: boolean;
};

/**
 * Returns Vite+ `run.tasks` entries for cedar-pg lifecycle.
 */
export function cedarPgTasks(options: CedarPgTasksOptions = {}): Record<string, CedarPgTaskDef> {
  const bin = options.bin ?? "cedar-pg";
  const tasks: Record<string, CedarPgTaskDef> = {
    [CEDAR_PG_TASK_ENSURE_DEV]: {
      command: `${bin} ensure --mode=dev`,
      cache: false,
    },
    [CEDAR_PG_TASK_ENSURE_TEST]: {
      command: `${bin} ensure --mode=test --print-env`,
      cache: false,
    },
  };
  if (options.includeDisposeTest !== false) {
    tasks[CEDAR_PG_TASK_DISPOSE_TEST] = {
      command: `${bin} dispose --mode=test`,
      cache: false,
    };
  }
  return tasks;
}
