import { expect, test, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRegistryLeases, readLease, writeLease, type Lease } from "../src/core/lease.ts";

function makeLease(partial: Partial<Lease> & Pick<Lease, "root" | "databaseName">): Lease {
  return {
    schemaVersion: 1,
    mode: "test",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    roleName: `${partial.databaseName}_role`,
    port: 5433,
    pid: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

async function withHostAndAutopgMocks<T>(
  adminUrl: string,
  autopgMocks: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/providers/host.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/host.ts")>(
      "../src/providers/host.ts",
    );
    return {
      ...actual,
      ensureHostRunning: async () => ({ port: 5433, adminUrl, bin: "autopg" }),
    };
  });
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ...autopgMocks,
    };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/providers/host.ts");
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
  }
}

test("ensure returns adminUrl alongside databaseUrl", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";

  try {
    await withHostAndAutopgMocks(adminUrl, { ensureDatabase: vi.fn(async () => {}) }, async () => {
      const { ensure } = await import("../src/core/lifecycle.ts");
      const result = await ensure({ root, mode: "test", setEnv: false });
      expect(result.adminUrl).toBe(adminUrl);
      expect(result.port).toBe(5433);
      expect(result.databaseUrl).toContain("127.0.0.1:5433");
      expect(result.databaseUrl).not.toContain("postgres:postgres");
    });
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("markTemplate + cloneFromTemplate use admin and lease role password", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_abcd1234";
  const lease = makeLease({ root, databaseName: templateName });
  writeLease(lease);

  const setTemplate = vi.fn(async () => {});
  const cloneDb = vi.fn(async () => {});
  const dropDb = vi.fn(async () => {});

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        setDatabaseIsTemplate: setTemplate,
        cloneDatabaseFromTemplate: cloneDb,
        dropDatabase: dropDb,
      },
      async () => {
        const { markTemplate, cloneFromTemplate, buildDatabaseUrl, rolePasswordFor } =
          await import("../src/index.ts");

        await expect(markTemplate({ root, mode: "test", adminUrl })).resolves.toEqual({
          databaseName: templateName,
          adminUrl,
        });
        expect(setTemplate).toHaveBeenCalledWith({
          adminUrl,
          databaseName: templateName,
          isTemplate: true,
        });

        const worker = await cloneFromTemplate({ root, mode: "test", adminUrl, name: "2" });
        expect(worker.templateName).toBe(templateName);
        expect(worker.roleName).toBe(lease.roleName);
        expect(worker.adminUrl).toBe(adminUrl);
        expect(worker.databaseName).toBe(`${templateName}_c_2`);
        expect(worker.databaseUrl).toBe(
          buildDatabaseUrl({
            port: 5433,
            databaseName: worker.databaseName,
            roleName: lease.roleName,
          }),
        );
        expect(new URL(worker.databaseUrl).password).toBe(rolePasswordFor(lease.roleName));
        expect(cloneDb).toHaveBeenCalledWith({
          adminUrl,
          templateName,
          databaseName: worker.databaseName,
          roleName: lease.roleName,
        });

        await worker.dropClone();
        expect(dropDb).toHaveBeenCalledWith({
          adminUrl,
          databaseName: worker.databaseName,
          roleName: lease.roleName,
        });
        // Template lease remains until suite dispose
        expect(readLease(root, "test")).toEqual(lease);
      },
    );
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose drops clones then template via admin (role-owned DBs)", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_tmpl0001";
  const lease = makeLease({ root, databaseName: templateName });
  writeLease(lease);

  const cloneA = `${templateName}_c_1`;
  const cloneB = `${templateName}_c_2`;
  const dropOwned = vi.fn(async () => [cloneA, cloneB, templateName]);

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        dropDatabasesOwnedByRole: dropOwned,
      },
      async () => {
        const { dispose } = await import("../src/core/lifecycle.ts");
        const result = await dispose({ root, mode: "test" });

        expect(result).toEqual({
          dropped: true,
          databaseName: templateName,
          droppedDatabases: [cloneA, cloneB, templateName],
        });
        expect(dropOwned).toHaveBeenCalledWith({
          adminUrl,
          roleName: lease.roleName,
          preferLast: templateName,
        });
        expect(readLease(root, "test")).toBeNull();
        expect(listRegistryLeases().map((l) => l.databaseName)).not.toContain(templateName);
      },
    );
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose with only the leased DB still lists owned then drops", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_single01";
  const lease = makeLease({ root, databaseName: templateName });
  writeLease(lease);

  const dropOwned = vi.fn(async () => [templateName]);

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        dropDatabasesOwnedByRole: dropOwned,
      },
      async () => {
        const { dispose } = await import("../src/core/lifecycle.ts");
        await expect(dispose({ root, mode: "test" })).resolves.toEqual({
          dropped: true,
          databaseName: templateName,
          droppedDatabases: [templateName],
        });
        expect(dropOwned).toHaveBeenCalledOnce();
        expect(dropOwned).toHaveBeenCalledWith({
          adminUrl,
          roleName: lease.roleName,
          preferLast: templateName,
        });
      },
    );
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose drops only role-owned DBs (never invents lease datname)", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_gone0001";
  const lease = makeLease({ root, databaseName: templateName });
  writeLease(lease);

  const cloneOnly = `${templateName}_c_1`;
  const dropOwned = vi.fn(async () => [cloneOnly]);

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        dropDatabasesOwnedByRole: dropOwned,
      },
      async () => {
        const { dispose } = await import("../src/core/lifecycle.ts");
        await expect(dispose({ root, mode: "test" })).resolves.toEqual({
          dropped: true,
          databaseName: templateName,
          droppedDatabases: [cloneOnly],
        });
        expect(dropOwned).toHaveBeenCalledWith({
          adminUrl,
          roleName: lease.roleName,
          preferLast: templateName,
        });
        expect(readLease(root, "test")).toBeNull();
      },
    );
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("markTemplate requires a lease", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  vi.resetModules();
  try {
    const { markTemplate } = await import("../src/core/template.ts");
    await expect(
      markTemplate({
        root,
        mode: "test",
        adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      }),
    ).rejects.toThrow(/no test lease/);
  } finally {
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("markTemplate + cloneFromTemplate rediscover adminUrl when omitted", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_rediscover";
  writeLease(makeLease({ root, databaseName: templateName }));

  const setTemplate = vi.fn(async () => {});
  const cloneDb = vi.fn(async () => {});

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        setDatabaseIsTemplate: setTemplate,
        cloneDatabaseFromTemplate: cloneDb,
      },
      async () => {
        const { markTemplate, cloneFromTemplate } = await import("../src/core/template.ts");
        await expect(markTemplate({ root, mode: "test" })).resolves.toEqual({
          databaseName: templateName,
          adminUrl,
        });
        const worker = await cloneFromTemplate({ root, mode: "test", name: "w" });
        expect(worker.adminUrl).toBe(adminUrl);
        expect(setTemplate).toHaveBeenCalledWith({
          adminUrl,
          databaseName: templateName,
          isTemplate: true,
        });
        expect(cloneDb).toHaveBeenCalledWith({
          adminUrl,
          templateName,
          databaseName: worker.databaseName,
          roleName: `${templateName}_role`,
        });
      },
    );
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneFromTemplateIfNeeded skips when CEDAR_PG disabled", async () => {
  const prevCedar = process.env.CEDAR_PG;
  process.env.CEDAR_PG = "0";
  const cloneDb = vi.fn(async () => {
    throw new Error("should not clone");
  });

  try {
    await withHostAndAutopgMocks(
      "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      { cloneDatabaseFromTemplate: cloneDb },
      async () => {
        const { cloneFromTemplateIfNeeded } = await import("../src/core/template.ts");
        await expect(
          cloneFromTemplateIfNeeded({ mode: "test", name: "1", setEnv: true }),
        ).resolves.toEqual({ status: "skipped", reason: "disabled" });
        expect(cloneDb).not.toHaveBeenCalled();
      },
    );
  } finally {
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
  }
});

test("cloneFromTemplateIfNeeded external-url skip applies DATABASE_URL env", async () => {
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;
  delete process.env.CEDAR_PG;
  process.env.TEST_DATABASE_URL = "postgresql://ci:ci@db.example/app";
  const cloneDb = vi.fn(async () => {
    throw new Error("should not clone");
  });

  try {
    await withHostAndAutopgMocks(
      "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      { cloneDatabaseFromTemplate: cloneDb },
      async () => {
        const { cloneFromTemplateIfNeeded } = await import("../src/core/template.ts");
        await expect(
          cloneFromTemplateIfNeeded({ mode: "test", name: "1", setEnv: true }),
        ).resolves.toEqual({
          status: "skipped",
          reason: "external-url",
          databaseUrl: "postgresql://ci:ci@db.example/app",
        });
        expect(cloneDb).not.toHaveBeenCalled();
        expect(process.env.DATABASE_URL).toBe("postgresql://ci:ci@db.example/app");
        expect(process.env.TEST_DATABASE_URL).toBe("postgresql://ci:ci@db.example/app");
      },
    );
  } finally {
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
  }
});

test("cloneFromTemplateIfNeeded clones when ensure policy allows", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  delete process.env.CEDAR_PG;
  delete process.env.TEST_DATABASE_URL;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_ifneeded1";
  const lease = makeLease({ root, databaseName: templateName });
  writeLease(lease);
  const cloneDb = vi.fn(async () => {});

  try {
    await withHostAndAutopgMocks(adminUrl, { cloneDatabaseFromTemplate: cloneDb }, async () => {
      const { cloneFromTemplateIfNeeded } = await import("../src/core/template.ts");
      const result = await cloneFromTemplateIfNeeded({
        root,
        mode: "test",
        adminUrl,
        name: "9",
        setEnv: false,
      });
      expect(result.status).toBe("cloned");
      if (result.status !== "cloned") throw new Error("expected cloned");
      expect(result.databaseName).toBe(`${templateName}_c_9`);
      expect(cloneDb).toHaveBeenCalledOnce();
    });
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneFromTemplateIfNeeded defaults setEnv on for clone path", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  delete process.env.CEDAR_PG;
  delete process.env.TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_ifneeded2";
  writeLease(makeLease({ root, databaseName: templateName }));

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      { cloneDatabaseFromTemplate: vi.fn(async () => {}) },
      async () => {
        const { cloneFromTemplateIfNeeded } = await import("../src/core/template.ts");
        const result = await cloneFromTemplateIfNeeded({
          root,
          mode: "test",
          adminUrl,
          name: "8",
        });
        expect(result.status).toBe("cloned");
        if (result.status !== "cloned") throw new Error("expected cloned");
        expect(process.env.DATABASE_URL).toBe(result.databaseUrl);
        expect(process.env.TEST_DATABASE_URL).toBe(result.databaseUrl);
      },
    );
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
