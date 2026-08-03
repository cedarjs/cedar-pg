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

        const worker = await cloneFromTemplate({ root, mode: "test", name: "2" });
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

        await worker.dispose();
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
  const droppedNames: string[] = [];
  const dropDb = vi.fn(async (opts: { databaseName: string }) => {
    droppedNames.push(opts.databaseName);
  });
  const listOwned = vi.fn(async () => [cloneA, templateName, cloneB]);

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        listDatabasesOwnedByRole: listOwned,
        dropDatabase: dropDb,
      },
      async () => {
        const { dispose } = await import("../src/core/lifecycle.ts");
        const result = await dispose({ root, mode: "test" });

        expect(result).toEqual({
          dropped: true,
          databaseName: templateName,
          droppedDatabases: [cloneA, cloneB, templateName],
        });
        expect(listOwned).toHaveBeenCalledWith({ adminUrl, roleName: lease.roleName });
        expect(droppedNames).toEqual([cloneA, cloneB, templateName]);
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

  const droppedNames: string[] = [];
  const dropDb = vi.fn(async (opts: { databaseName: string }) => {
    droppedNames.push(opts.databaseName);
  });
  const listOwned = vi.fn(async () => [templateName]);

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        listDatabasesOwnedByRole: listOwned,
        dropDatabase: dropDb,
      },
      async () => {
        const { dispose } = await import("../src/core/lifecycle.ts");
        await expect(dispose({ root, mode: "test" })).resolves.toEqual({
          dropped: true,
          databaseName: templateName,
          droppedDatabases: [templateName],
        });
        expect(listOwned).toHaveBeenCalledOnce();
        expect(droppedNames).toEqual([templateName]);
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
  const droppedNames: string[] = [];
  const dropDb = vi.fn(async (opts: { databaseName: string }) => {
    droppedNames.push(opts.databaseName);
  });
  const listOwned = vi.fn(async () => [cloneOnly]);

  try {
    await withHostAndAutopgMocks(
      adminUrl,
      {
        listDatabasesOwnedByRole: listOwned,
        dropDatabase: dropDb,
      },
      async () => {
        const { dispose } = await import("../src/core/lifecycle.ts");
        await expect(dispose({ root, mode: "test" })).resolves.toEqual({
          dropped: true,
          databaseName: templateName,
          droppedDatabases: [cloneOnly],
        });
        expect(droppedNames).toEqual([cloneOnly]);
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
    const { markTemplate } = await import("../src/core/lifecycle.ts");
    await expect(markTemplate({ root, mode: "test" })).rejects.toThrow(/no test lease/);
  } finally {
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneFromTemplateIfNeeded external-url skip shares applyDatabaseUrlEnv", async () => {
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;
  delete process.env.CEDAR_PG;
  process.env.TEST_DATABASE_URL = "postgresql://ci:ci@db.example/app";

  try {
    const { cloneFromTemplateIfNeeded } = await import("../src/core/lifecycle.ts");
    const result = await cloneFromTemplateIfNeeded({ mode: "test", setEnv: true });
    expect(result).toEqual({
      status: "skipped",
      reason: "external-url",
      databaseUrl: "postgresql://ci:ci@db.example/app",
    });
    expect(process.env.DATABASE_URL).toBe("postgresql://ci:ci@db.example/app");
    expect(process.env.TEST_DATABASE_URL).toBe("postgresql://ci:ci@db.example/app");
  } finally {
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
  }
});
