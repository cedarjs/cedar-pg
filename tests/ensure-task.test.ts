import { expect, test, vi } from "vite-plus/test";
import type { EnsureIfNeededResult } from "../src/core/lifecycle.ts";

function ensuredLease(
  overrides: Partial<Extract<EnsureIfNeededResult, { status: "ensured" }>> = {},
): Extract<EnsureIfNeededResult, { status: "ensured" }> {
  return {
    status: "ensured",
    databaseUrl: "postgresql://u:p@127.0.0.1:1/db",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
    databaseName: "db",
    roleName: "db_role",
    repoSlug: "r",
    worktreeSlug: "w",
    pathHash: "abcd1234",
    root: "/tmp/x",
    mode: "dev",
    port: 1,
    dispose: async () => {},
    ...overrides,
  };
}

async function withMockedEnsure<T>(
  ensureIfNeeded: ReturnType<typeof vi.fn>,
  run: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/core/lifecycle.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/core/lifecycle.ts")>(
      "../src/core/lifecycle.ts",
    );
    return { ...actual, ensureIfNeeded };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/core/lifecycle.ts");
    vi.resetModules();
  }
}

test("createEnsureTask runs afterEnsure only when ensure succeeds", async () => {
  const afterEnsure = vi.fn();
  const ensureIfNeeded = vi.fn(async () => ensuredLease());
  await withMockedEnsure(ensureIfNeeded, async () => {
    const { createEnsureTask } = await import("../src/adapters/ensure-task.ts");
    await createEnsureTask({ mode: "dev", afterEnsure })();
  });
  expect(ensureIfNeeded).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "dev", setEnv: true }),
  );
  expect(afterEnsure).toHaveBeenCalledWith(
    expect.objectContaining({
      databaseUrl: "postgresql://u:p@127.0.0.1:1/db",
      mode: "dev",
    }),
  );
});

test("createEnsureTask skips afterEnsure when ensure is skipped", async () => {
  const afterEnsure = vi.fn();
  const ensureIfNeeded = vi.fn(async () => ({
    status: "skipped" as const,
    reason: "disabled" as const,
  }));
  await withMockedEnsure(ensureIfNeeded, async () => {
    const { createEnsureTask } = await import("../src/adapters/ensure-task.ts");
    await createEnsureTask({ mode: "test", afterEnsure })();
  });
  expect(afterEnsure).not.toHaveBeenCalled();
});
