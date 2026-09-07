import { CLI_NAME } from "../core/constants.ts";
import type { DevStatus } from "../core/status.ts";
import { CEDAR_PG_TASK_ACQUIRE_DEV, CEDAR_PG_TASK_ACQUIRE_TEST } from "./tasks.ts";

/** Human-readable lines for the Vite panel / `cedarpg status`. */
export function formatDevStatus(status: DevStatus): string[] {
  if (!status.ok) {
    const task = status.mode === "test" ? CEDAR_PG_TASK_ACQUIRE_TEST : CEDAR_PG_TASK_ACQUIRE_DEV;
    return [
      `${CLI_NAME}: no ${status.mode} lease at ${status.root}`,
      `  run \`${CLI_NAME} acquire --mode=${status.mode}\` (or depend on ${task})`,
    ];
  }
  const { lease, databaseUrl, envPath } = status;
  return [
    `${CLI_NAME}: ${lease.databaseName} (${lease.repoSlug}/${lease.worktreeSlug} ${lease.mode})`,
    `  port          ${lease.port}`,
    `  DATABASE_URL  ${databaseUrl}`,
    `  env           ${envPath}`,
  ];
}
