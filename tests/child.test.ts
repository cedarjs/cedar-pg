import { expect, test } from "vite-plus/test";
import { runAttached } from "../src/adapters/child.ts";

const WAIT = "setInterval(() => {}, 1000)";

function listenerCounts(): number[] {
  return ["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s));
}

test("runAttached resolves the child's exit code", async () => {
  await expect(runAttached(process.execPath, ["-e", "process.exit(3)"])).resolves.toBe(3);
});

test("runAttached resolves 128 + n when the child is killed by a signal", async () => {
  await expect(
    runAttached(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]),
  ).resolves.toBe(137);
});

test("runAttached forwards SIGTERM to the child and resolves 143", async () => {
  const before = listenerCounts();
  const exit = runAttached(process.execPath, ["-e", WAIT]);
  expect(process.listenerCount("SIGTERM")).toBe(before[1]! + 1);
  // Simulate a supervisor signalling only the parent.
  process.emit("SIGTERM", "SIGTERM");
  await expect(exit).resolves.toBe(143);
  expect(listenerCounts()).toEqual(before);
});

test("runAttached detaches signal listeners when spawn fails", async () => {
  const before = listenerCounts();
  await expect(runAttached("cedarpg-definitely-missing-binary", [])).rejects.toThrow(/ENOENT/);
  expect(listenerCounts()).toEqual(before);
});
