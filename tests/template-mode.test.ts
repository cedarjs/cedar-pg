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
    truncateUserTables?: ReturnType<typeof vi.fn>;
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
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      truncateUserTables: mocks.truncateUserTables ?? vi.fn(async () => []),
    };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/core/lifecycle.ts");
    vi.doUnmock("../src/core/template.ts");
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
  }
}

test("setupTemplateMode fresh-acquires, migrates, then markTemplate", async () => {
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
    // fresh: leftovers from a crashed run are dropped before migrate
    expect(acquireIfNeeded).toHaveBeenCalledWith({
      root: undefined,
      mode: "test",
      fresh: true,
      setEnv: false,
    });
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

async function withWorkerEnv(workerId: string, run: () => Promise<void>): Promise<void> {
  const prevJest = process.env.JEST_WORKER_ID;
  const prevCedar = process.env.CEDAR_PG;
  process.env.JEST_WORKER_ID = workerId;
  delete process.env.CEDAR_PG;
  try {
    await run();
  } finally {
    if (prevJest === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = prevJest;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
  }
}

test("cloneWorkerDatabase clones the worker id with reuse + setEnv", async () => {
  const cloneFromTemplateIfNeeded = vi.fn(async () => clonedWorker());

  await withWorkerEnv("3", () =>
    withMockedCore({ cloneFromTemplateIfNeeded }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase({ root: "/tmp/wt" });
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledWith({
        root: "/tmp/wt",
        mode: "test",
        name: "3",
        reuse: true,
        setEnv: true,
      });
    }),
  );
});

test("cloneWorkerDatabase reaches the DB with reuse from every test file", async () => {
  // Jest gives each file a fresh globalThis + module registry, so nothing
  // in-process can dedupe: each file must ask to reuse <tmpl>_c_<workerId>.
  const cloneFromTemplateIfNeeded = vi
    .fn()
    .mockResolvedValueOnce(clonedWorker({ databaseName: "cpg_tmpl_c_1" }))
    .mockResolvedValueOnce(clonedWorker({ databaseName: "cpg_tmpl_c_1" }));

  await withWorkerEnv("1", () =>
    withMockedCore({ cloneFromTemplateIfNeeded }, async () => {
      const first = await import("../src/adapters/template-mode.ts");
      await first.cloneWorkerDatabase({ root: "/tmp/wt" });
      vi.resetModules();
      const second = await import("../src/adapters/template-mode.ts");
      await second.cloneWorkerDatabase({ root: "/tmp/wt" });
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledTimes(2);
      for (const [options] of cloneFromTemplateIfNeeded.mock.calls) {
        expect(options).toMatchObject({ name: "1", reuse: true });
      }
    }),
  );
});

test("cloneWorkerDatabase truncates with identity restart on every file", async () => {
  // Reused clone: rows and sequences from the previous file must not leak in.
  const cloneFromTemplateIfNeeded = vi.fn(async () => clonedWorker());
  const truncateUserTables = vi.fn(async () => ["public.users"]);

  await withWorkerEnv("3", () =>
    withMockedCore({ cloneFromTemplateIfNeeded, truncateUserTables }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase();
      await cloneWorkerDatabase();
      expect(truncateUserTables).toHaveBeenCalledTimes(2);
      expect(truncateUserTables).toHaveBeenCalledWith({
        adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
        databaseName: "cpg_tmpl_c_3",
      });
    }),
  );
});

test("cloneWorkerDatabase reset none keeps the clone's rows", async () => {
  const cloneFromTemplateIfNeeded = vi.fn(async () => clonedWorker());
  const truncateUserTables = vi.fn(async () => []);

  await withWorkerEnv("3", () =>
    withMockedCore({ cloneFromTemplateIfNeeded, truncateUserTables }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase({ reset: "none" });
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledTimes(1);
      expect(truncateUserTables).not.toHaveBeenCalled();
    }),
  );
});

test("cloneWorkerDatabase never truncates a skipped (external) database", async () => {
  const cloneFromTemplateIfNeeded = vi.fn(async () => ({
    status: "skipped" as const,
    reason: "external-url" as const,
    databaseUrl: "postgresql://me@db.example.com/app_test",
  }));
  const truncateUserTables = vi.fn(async () => []);

  await withWorkerEnv("3", () =>
    withMockedCore({ cloneFromTemplateIfNeeded, truncateUserTables }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await cloneWorkerDatabase();
      expect(truncateUserTables).not.toHaveBeenCalled();
    }),
  );
});

test("cloneWorkerDatabase propagates clone failures", async () => {
  const cloneFromTemplateIfNeeded = vi.fn(async () => {
    throw new Error("database already exists: cpg_tmpl_c_1 (owned by someone_else)");
  });

  await withWorkerEnv("1", () =>
    withMockedCore({ cloneFromTemplateIfNeeded }, async () => {
      const { cloneWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await expect(cloneWorkerDatabase()).rejects.toThrow(/owned by someone_else/);
    }),
  );
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
