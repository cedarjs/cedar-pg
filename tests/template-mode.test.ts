import { expect, test, vi } from "vite-plus/test";
import type { AcquireIfNeededResult } from "../src/core/lifecycle.ts";
import type { CloneFromTemplateIfNeededResult } from "../src/core/template.ts";

function acquiredLease(
  overrides: Partial<Extract<AcquireIfNeededResult, { status: "acquired" }>> = {},
): Extract<AcquireIfNeededResult, { status: "acquired" }> {
  return {
    status: "acquired",
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl",
    roleName: "cpg_tmpl_role",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    root: "/tmp/wt",
    mode: "test",
    port: 5433,
    dispose: async () => {},
    ...overrides,
  };
}

function clonedWorker(
  overrides: Partial<Extract<CloneFromTemplateIfNeededResult, { status: "cloned" }>> = {},
): Extract<CloneFromTemplateIfNeededResult, { status: "cloned" }> {
  return {
    status: "cloned",
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl_c_3",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl_c_3",
    roleName: "cpg_tmpl_role",
    templateName: "cpg_tmpl",
    port: 5433,
    dropClone: async () => {},
    ...overrides,
  };
}

async function withMockedCore<T>(
  mocks: {
    acquireIfNeeded?: ReturnType<typeof vi.fn>;
    markTemplate?: ReturnType<typeof vi.fn>;
    cloneFromTemplateIfNeeded?: ReturnType<typeof vi.fn>;
    dispose?: ReturnType<typeof vi.fn>;
  },
  run: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/core/lifecycle.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/core/lifecycle.ts")>(
      "../src/core/lifecycle.ts",
    );
    return {
      ...actual,
      acquireIfNeeded: mocks.acquireIfNeeded ?? actual.acquireIfNeeded,
      dispose: mocks.dispose ?? actual.dispose,
    };
  });
  vi.doMock("../src/core/template.ts", async () => {
    const actual =
      await vi.importActual<typeof import("../src/core/template.ts")>("../src/core/template.ts");
    return {
      ...actual,
      markTemplate: mocks.markTemplate ?? actual.markTemplate,
      cloneFromTemplateIfNeeded:
        mocks.cloneFromTemplateIfNeeded ?? actual.cloneFromTemplateIfNeeded,
    };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/core/lifecycle.ts");
    vi.doUnmock("../src/core/template.ts");
    vi.resetModules();
  }
}

test("setupTemplateMode acquires, migrates, then markTemplate", async () => {
  const acquireIfNeeded = vi.fn(async () => acquiredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedCore({ acquireIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    const result = await setupTemplateMode({ migrate, setEnv: false });
    expect(result.status).toBe("acquired");
    expect(process.env.CEDAR_PG_ADMIN_URL).toBeUndefined();
    expect(migrate).toHaveBeenCalledWith({
      databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
      adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      databaseName: "cpg_tmpl",
      roleName: "cpg_tmpl_role",
    });
    expect(markTemplate).toHaveBeenCalledWith({
      root: "/tmp/wt",
      mode: "test",
      adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    });
  });
});

test("setupTemplateMode disposes and wraps markTemplate failure after migrate", async () => {
  const acquireIfNeeded = vi.fn(async () => acquiredLease());
  const markTemplate = vi.fn(async () => {
    throw new Error("permission denied");
  });
  const dispose = vi.fn(async () => ({
    dropped: true as const,
    databaseName: "cpg_tmpl",
    droppedDatabases: ["cpg_tmpl"],
  }));
  const migrate = vi.fn(async () => {});

  await withMockedCore({ acquireIfNeeded, markTemplate, dispose }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    await expect(setupTemplateMode({ migrate })).rejects.toThrow(
      /template setup failed after acquire; cleaned up lease DB \(cpg_tmpl\).*permission denied/,
    );
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith({ root: "/tmp/wt", mode: "test" });
  });
});

test("setupTemplateMode disposes when migrate fails before markTemplate", async () => {
  const acquireIfNeeded = vi.fn(async () => acquiredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const dispose = vi.fn(async () => ({
    dropped: true as const,
    databaseName: "cpg_tmpl",
    droppedDatabases: ["cpg_tmpl"],
  }));
  const migrate = vi.fn(async () => {
    throw new Error("migrate boom");
  });

  await withMockedCore({ acquireIfNeeded, markTemplate, dispose }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    await expect(setupTemplateMode({ migrate })).rejects.toThrow(
      /template setup failed after acquire; cleaned up lease DB \(cpg_tmpl\).*migrate boom/,
    );
    expect(markTemplate).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith({ root: "/tmp/wt", mode: "test" });
  });
});

test("setupTemplateMode skips migrate/mark when acquire is skipped", async () => {
  const acquireIfNeeded = vi.fn(async () => ({
    status: "skipped" as const,
    reason: "disabled" as const,
  }));
  const markTemplate = vi.fn(async () => ({
    databaseName: "x",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedCore({ acquireIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    const result = await setupTemplateMode({ migrate });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(migrate).not.toHaveBeenCalled();
    expect(markTemplate).not.toHaveBeenCalled();
  });
});

test("cloneWorkerDatabase clones via cloneFromTemplateIfNeeded with setEnv true", async () => {
  const prevJest = process.env.JEST_WORKER_ID;
  const prevCedar = process.env.CEDAR_PG;
  process.env.JEST_WORKER_ID = "3";
  delete process.env.CEDAR_PG;

  const cloneFromTemplateIfNeeded = vi.fn(async () => clonedWorker());

  try {
    await withMockedCore({ cloneFromTemplateIfNeeded }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase({ root: "/tmp/wt" });
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledWith({
        root: "/tmp/wt",
        mode: "test",
        name: "3",
        setEnv: true,
      });
    });
  } finally {
    if (prevJest === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = prevJest;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
  }
});

test("cloneWorkerDatabase is idempotent per process", async () => {
  const prevJest = process.env.JEST_WORKER_ID;
  const prevCedar = process.env.CEDAR_PG;
  process.env.JEST_WORKER_ID = "1";
  delete process.env.CEDAR_PG;

  const cloneFromTemplateIfNeeded = vi.fn(async () =>
    clonedWorker({ databaseName: "cpg_tmpl_c_1" }),
  );

  try {
    await withMockedCore({ cloneFromTemplateIfNeeded }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase();
      await cloneWorkerDatabase();
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledTimes(1);
    });
  } finally {
    if (prevJest === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = prevJest;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
  }
});

test("cloneWorkerDatabase rejects conflicting root/name after first call", async () => {
  const prevJest = process.env.JEST_WORKER_ID;
  const prevCedar = process.env.CEDAR_PG;
  process.env.JEST_WORKER_ID = "1";
  delete process.env.CEDAR_PG;

  const cloneFromTemplateIfNeeded = vi.fn(async () =>
    clonedWorker({ databaseName: "cpg_tmpl_c_1" }),
  );

  try {
    await withMockedCore({ cloneFromTemplateIfNeeded }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase({ root: "/tmp/a" });
      expect(() => cloneWorkerDatabase({ root: "/tmp/b" })).toThrow(
        /already started with different root\/name/,
      );
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledTimes(1);
    });
  } finally {
    if (prevJest === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = prevJest;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
  }
});

test("vitest template teardown uses AcquireResult.dispose", async () => {
  const disposeFn = vi.fn(async () => {});
  const acquireIfNeeded = vi.fn(async () => acquiredLease({ dispose: disposeFn }));
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedCore({ acquireIfNeeded, markTemplate }, async () => {
    const { createGlobalSetup } = await import("../src/adapters/vitest-template.ts");
    const teardown = await createGlobalSetup({ migrate })();
    await teardown();
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });
});

test("jest createGlobalSetup wires migrate hook", async () => {
  const acquireIfNeeded = vi.fn(async () => acquiredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedCore({ acquireIfNeeded, markTemplate }, async () => {
    const { createGlobalSetup } = await import("../src/adapters/jest-template.ts");
    await createGlobalSetup({ migrate })();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(markTemplate).toHaveBeenCalledTimes(1);
  });
});

test("jest template default export requires createGlobalSetup", async () => {
  vi.resetModules();
  const mod = await import("../src/adapters/jest-template.ts");
  await expect(mod.default()).rejects.toThrow(/createGlobalSetup/);
  vi.resetModules();
});

test("vitest template default export requires createGlobalSetup", async () => {
  vi.resetModules();
  const mod = await import("../src/adapters/vitest-template.ts");
  await expect(mod.default()).rejects.toThrow(/createGlobalSetup/);
  vi.resetModules();
});

test("jest template re-exports cloneWorkerDatabase", async () => {
  const { cloneWorkerDatabase: fromJest } = await import("../src/adapters/jest-template.ts");
  const { cloneWorkerDatabase: fromMode } = await import("../src/adapters/template-mode.ts");
  expect(fromJest).toBe(fromMode);
});
