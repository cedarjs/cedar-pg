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

test("ensure returns adminUrl alongside databaseUrl", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  vi.resetModules();
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ensureHostRunning: () => ({ port: 5433, adminUrl, bin: "autopg" }),
      ensureDatabase: vi.fn(async () => {}),
    };
  });

  try {
    const { ensure } = await import("../src/core/lifecycle.ts");
    const result = await ensure({ root, mode: "test", setEnv: false });
    expect(result.adminUrl).toBe(adminUrl);
    expect(result.port).toBe(5433);
    expect(result.databaseUrl).toContain("127.0.0.1:5433");
    expect(result.databaseUrl).not.toContain("postgres:postgres");
  } finally {
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
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

  vi.resetModules();
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ensureHostRunning: () => ({ port: 5433, adminUrl, bin: "autopg" }),
      setDatabaseIsTemplate: setTemplate,
      cloneDatabaseFromTemplate: cloneDb,
      dropDatabase: dropDb,
    };
  });

  try {
    const { markTemplate, cloneFromTemplate, buildDatabaseUrl, rolePasswordFor } =
      await import("../src/index.ts");

    await expect(markTemplate({ root, mode: "test" })).resolves.toEqual({
      databaseName: templateName,
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
  } finally {
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose dropOwnedDatabases drops clones then template via admin", async () => {
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

  vi.resetModules();
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ensureHostRunning: () => ({ port: 5433, adminUrl, bin: "autopg" }),
      listDatabasesOwnedByRole: listOwned,
      dropDatabase: dropDb,
    };
  });

  try {
    const { dispose } = await import("../src/core/lifecycle.ts");
    const result = await dispose({ root, mode: "test", dropOwnedDatabases: true });

    expect(result).toEqual({
      dropped: true,
      databaseName: templateName,
      droppedDatabases: [cloneA, cloneB, templateName],
    });
    expect(listOwned).toHaveBeenCalledWith({ adminUrl, roleName: lease.roleName });
    expect(droppedNames).toEqual([cloneA, cloneB, templateName]);
    expect(readLease(root, "test")).toBeNull();
    expect(listRegistryLeases().map((l) => l.databaseName)).not.toContain(templateName);
  } finally {
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose without dropOwnedDatabases still returns droppedDatabases", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const templateName = "cpg_cedar_main_test_single01";
  const lease = makeLease({ root, databaseName: templateName });
  writeLease(lease);

  const dropDb = vi.fn(async () => {});
  const listOwned = vi.fn(async () => {
    throw new Error("should not list owned when dropOwnedDatabases is false");
  });

  vi.resetModules();
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ensureHostRunning: () => ({ port: 5433, adminUrl, bin: "autopg" }),
      listDatabasesOwnedByRole: listOwned,
      dropDatabase: dropDb,
    };
  });

  try {
    const { dispose } = await import("../src/core/lifecycle.ts");
    await expect(dispose({ root, mode: "test" })).resolves.toEqual({
      dropped: true,
      databaseName: templateName,
      droppedDatabases: [templateName],
    });
    expect(listOwned).not.toHaveBeenCalled();
    expect(dropDb).toHaveBeenCalledTimes(1);
  } finally {
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
