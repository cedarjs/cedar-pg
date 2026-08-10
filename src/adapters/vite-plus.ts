/**
 * Consumer adapter for external Vite+ projects.
 *
 * - `cedarPgTasks()` — merge into `run.tasks` so `vp run test` / `vp run dev`
 *   depend on cedarpg acquire.
 * - `cedarPgDev()` — Vite plugin: status panel + `d` / `p` shortcuts (no acquire).
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vite-plus'
 * import { cedarPgTasks, cedarPgDev } from '@cedarjs/pg/vite-plus'
 *
 * export default defineConfig({
 *   plugins: [cedarPgDev()],
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

export { cedarPgDev } from "./vite-dev-plugin.ts";
export type { CedarPgDevOptions } from "./vite-dev-plugin.ts";
