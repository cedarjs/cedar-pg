import { expect, test, vi } from "vite-plus/test";
import type { AcquireIfNeededResult } from "../src/core/lifecycle.ts";

function acquiredLease(
  overrides: Partial<Extract<AcquireIfNeededResult, { status: "acquired" }>> = {},
): Extract<AcquireIfNeededResult, { status: "acquired" }> {
  return {
    status: "acquired",
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

async function withMockedAcquire<T>(
  acquireIfNeeded: ReturnType<typeof vi.fn>,
  run: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/core/lifecycle.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/core/lifecycle.ts")>(
      "../src/core/lifecycle.ts",
    );
    return { ...actual, acquireIfNeeded };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/core/lifecycle.ts");
    vi.resetModules();
  }
}

test("createAcquireTask runs afterAcquire only when acquire succeeds", async () => {
  const afterAcquire = vi.fn();
  const acquireIfNeeded = vi.fn(async () => acquiredLease());
  await withMockedAcquire(acquireIfNeeded, async () => {
    const { createAcquireTask } = await import("../src/adapters/acquire-task.ts");
    await createAcquireTask({ mode: "dev", afterAcquire })();
  });
  expect(acquireIfNeeded).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "dev", setEnv: true }),
  );
  expect(afterAcquire).toHaveBeenCalledWith(
    expect.objectContaining({
      databaseUrl: "postgresql://u:p@127.0.0.1:1/db",
      mode: "dev",
    }),
  );
});

test("createAcquireTask skips afterAcquire when acquire is skipped", async () => {
  const afterAcquire = vi.fn();
  const acquireIfNeeded = vi.fn(async () => ({
    status: "skipped" as const,
    reason: "disabled" as const,
  }));
  await withMockedAcquire(acquireIfNeeded, async () => {
    const { createAcquireTask } = await import("../src/adapters/acquire-task.ts");
    await createAcquireTask({ mode: "test", afterAcquire })();
  });
  expect(afterAcquire).not.toHaveBeenCalled();
});
