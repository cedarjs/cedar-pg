import { expect, test } from "vite-plus/test";
import {
  cedarPgTasks,
  CEDAR_PG_TASK_ENSURE_DEV,
  CEDAR_PG_TASK_ENSURE_TEST,
} from "../src/adapters/vite-plus.ts";

test("cedarPgTasks exposes ensure tasks for Vite+ run.tasks", () => {
  const tasks = cedarPgTasks();
  expect(tasks[CEDAR_PG_TASK_ENSURE_DEV]?.command).toContain("ensure --mode=dev");
  expect(tasks[CEDAR_PG_TASK_ENSURE_TEST]?.command).toContain("ensure --mode=test");
  expect(tasks[CEDAR_PG_TASK_ENSURE_DEV]?.cache).toBe(false);
});

test("cedarPgTasks respects custom bin", () => {
  const tasks = cedarPgTasks({ bin: "./bin/cedar-pg" });
  expect(tasks[CEDAR_PG_TASK_ENSURE_DEV]?.command.startsWith("./bin/cedar-pg")).toBe(true);
});
