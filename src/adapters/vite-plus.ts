/**
 * Consumer adapter for external Vite+ projects.
 *
 * Merge into `vite.config.ts` `run.tasks` so `vp run test` / `vp run dev`
 * depend on cedarpg acquire.
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
 *         dependsOn: ['db:acquire-test'],
 *         env: ['DATABASE_URL', 'TEST_DATABASE_URL'],
 *       },
 *       dev: {
 *         command: 'vp dev',
 *         dependsOn: ['db:acquire'],
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
  CEDAR_PG_TASK_ACQUIRE_DEV,
  CEDAR_PG_TASK_ACQUIRE_TEST,
} from "./tasks.ts";

export {
  CEDAR_PG_TASK_ACQUIRE_DEV,
  CEDAR_PG_TASK_ACQUIRE_TEST,
  CEDAR_PG_TASK_DISPOSE_TEST,
  cedarPgLifecycleTargets as cedarPgTasks,
};

export type CedarPgTaskDef = CedarPgLifecycleTarget;
export type CedarPgTasksOptions = CedarPgLifecycleTargetsOptions;
