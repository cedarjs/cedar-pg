import { expect, test } from "vite-plus/test";
import {
  cedarPgTasks,
  CEDAR_PG_TASK_ACQUIRE_DEV,
  CEDAR_PG_TASK_ACQUIRE_TEST,
} from "../src/adapters/vite-plus.ts";

test("cedarPgTasks exposes acquire tasks for Vite+ run.tasks", () => {
  const tasks = cedarPgTasks();
  expect(tasks[CEDAR_PG_TASK_ACQUIRE_DEV]?.command).toContain("acquire --mode=dev");
  expect(tasks[CEDAR_PG_TASK_ACQUIRE_TEST]?.command).toContain("acquire --mode=test");
  expect(tasks[CEDAR_PG_TASK_ACQUIRE_DEV]?.cache).toBe(false);
});

test("cedarPgTasks respects custom bin", () => {
  const tasks = cedarPgTasks({ bin: "./bin/cedarpg" });
  expect(tasks[CEDAR_PG_TASK_ACQUIRE_DEV]?.command.startsWith("./bin/cedarpg")).toBe(true);
});
