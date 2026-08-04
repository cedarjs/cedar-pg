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

import {
  cedarPgLifecycleTargets,
  type CedarPgLifecycleTarget,
  type CedarPgLifecycleTargetsOptions,
  CEDAR_PG_TASK_DISPOSE_TEST,
  CEDAR_PG_TASK_ENSURE_DEV,
  CEDAR_PG_TASK_ENSURE_TEST,
} from "./tasks.ts";

export {
  CEDAR_PG_TASK_ENSURE_DEV,
  CEDAR_PG_TASK_ENSURE_TEST,
  CEDAR_PG_TASK_DISPOSE_TEST,
  cedarPgLifecycleTargets as cedarPgTasks,
};

export type CedarPgTaskDef = CedarPgLifecycleTarget;
export type CedarPgTasksOptions = CedarPgLifecycleTargetsOptions;
