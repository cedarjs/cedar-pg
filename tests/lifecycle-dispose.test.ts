import { expect, test, vi } from "vite-plus/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envPath,
  listRegistryLeases,
  readLease,
  writeLease,
  type Lease,
} from "../src/core/lease.ts";

function makeLease(partial: Partial<Lease> & Pick<Lease, "root" | "databaseName">): Lease {
  return {
    schemaVersion: 1,
    mode: "test",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    roleName: `${partial.databaseName}_role`,
    port: 5432,
    pid: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("dispose is a no-op without a lease (never invents a DROP target)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  try {
    const { dispose } = await import("../src/core/lifecycle.ts");
    await expect(dispose({ root, mode: "test" })).resolves.toEqual({
      dropped: false,
      reason: "no-lease",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose removes mode env after successful DROP", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  vi.resetModules();
  vi.doMock("../src/providers/host.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/host.ts")>(
      "../src/providers/host.ts",
    );
    return {
      ...actual,
      ensureHostRunning: async () => ({
        adminUrl: "postgresql://postgres@127.0.0.1:5432/postgres",
        port: 5432,
      }),
    };
  });
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      dropDatabase: vi.fn(async () => {}),
    };
  });

  try {
    const lease = makeLease({
      root,
      databaseName: "cpg_cedar_main_test_disposeenv",
    });
    writeLease(lease);
    writeFileSync(envPath(root, "test"), "DATABASE_URL=postgresql://u:p@127.0.0.1:5432/db\n", {
      mode: 0o600,
    });

    const { dispose } = await import("../src/core/lifecycle.ts");
    await expect(dispose({ root, mode: "test" })).resolves.toEqual({
      dropped: true,
      databaseName: lease.databaseName,
    });

    expect(readLease(root, "test")).toBeNull();
    expect(existsSync(envPath(root, "test"))).toBe(false);
    expect(listRegistryLeases().map((l) => l.databaseName)).not.toContain(lease.databaseName);
  } finally {
    vi.doUnmock("../src/providers/host.ts");
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose leaves lease+registry when host is unavailable", async () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;

  vi.resetModules();
  vi.doMock("../src/providers/host.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/host.ts")>(
      "../src/providers/host.ts",
    );
    return {
      ...actual,
      ensureHostRunning: () => {
        throw new Error("autopg down");
      },
    };
  });
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      dropDatabase: vi.fn(),
    };
  });

  try {
    const lease = makeLease({
      root,
      databaseName: "cpg_cedar_main_test_hostdown",
    });
    writeLease(lease);

    const { dispose } = await import("../src/core/lifecycle.ts");
    const autopg = await import("../src/providers/autopg.ts");

    await expect(dispose({ root, mode: "test" })).resolves.toEqual({
      dropped: false,
      reason: "host-unavailable",
    });

    expect(readLease(root, "test")).toEqual(lease);
    expect(listRegistryLeases().map((l) => l.databaseName)).toContain(lease.databaseName);
    expect(autopg.dropDatabase).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("../src/providers/host.ts");
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
