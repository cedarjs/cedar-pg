import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLease, writeLease, type Lease } from "../src/core/lease.ts";
import { buildDatabaseName, buildRoleName } from "../src/core/naming.ts";
import { resolveWorktreeIdentity } from "../src/core/worktree.ts";

let registry: string;
let root: string;
let prevRegistry: string | undefined;

beforeEach(() => {
  registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  // Long basename → a 63-char database name, where pre-#44 role naming cut the hash.
  root = mkdtempSync(join(tmpdir(), "cedarpg-wt-a-long-worktree-name-for-the-role-upgrade-"));
  prevRegistry = process.env.CEDAR_PG_REGISTRY_DIR;
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
        bin: "autopg",
      }),
    };
  });
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ensureDatabase: vi.fn(async () => {}),
      dropDatabasesOwnedByRole: vi.fn(async () => []),
    };
  });
});

afterEach(() => {
  vi.doUnmock("../src/providers/host.ts");
  vi.doUnmock("../src/providers/autopg.ts");
  vi.resetModules();
  if (prevRegistry === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
  else process.env.CEDAR_PG_REGISTRY_DIR = prevRegistry;
  rmSync(registry, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function seedLease(databaseName: string, roleName: string): Lease {
  const identity = resolveWorktreeIdentity(root);
  const lease: Lease = {
    schemaVersion: 1,
    mode: "dev",
    root: identity.root,
    repoSlug: identity.repoSlug,
    worktreeSlug: identity.worktreeSlug,
    pathHash: identity.pathHash,
    databaseName,
    roleName,
    port: 5432,
    pid: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  writeLease(lease);
  return lease;
}

test("acquire keeps the lease's role for the same database (pre-#44 cut role survives)", async () => {
  const databaseName = buildDatabaseName(resolveWorktreeIdentity(root), "dev");
  const oldRole = `${databaseName.slice(0, 58)}_role`;
  expect(databaseName).toHaveLength(63);
  expect(buildRoleName(databaseName)).not.toBe(oldRole);
  seedLease(databaseName, oldRole);

  const { acquire } = await import("../src/core/lifecycle.ts");
  const autopg = await import("../src/providers/autopg.ts");
  const result = await acquire({ root, mode: "dev", setEnv: false, fresh: true });

  expect(result.roleName).toBe(oldRole);
  expect(result.databaseUrl).toContain(`${oldRole}:`);
  expect(autopg.ensureDatabase).toHaveBeenCalledWith(
    expect.objectContaining({ databaseName, roleName: oldRole }),
  );
  expect(autopg.dropDatabasesOwnedByRole).toHaveBeenCalledWith(
    expect.objectContaining({ roleName: oldRole }),
  );
  expect(readLease(root, "dev")?.roleName).toBe(oldRole);
});

test("acquire derives the role when the lease is for a different database", async () => {
  const databaseName = buildDatabaseName(resolveWorktreeIdentity(root), "dev");
  seedLease("cpg_other_db_dev_00000000", "cpg_other_db_dev_00000000_role");

  const { acquire } = await import("../src/core/lifecycle.ts");
  const autopg = await import("../src/providers/autopg.ts");
  const result = await acquire({ root, mode: "dev", setEnv: false });

  expect(result.databaseName).toBe(databaseName);
  expect(result.roleName).toBe(buildRoleName(databaseName));
  expect(autopg.ensureDatabase).toHaveBeenCalledWith(
    expect.objectContaining({ databaseName, roleName: buildRoleName(databaseName) }),
  );
  expect(readLease(root, "dev")?.roleName).toBe(buildRoleName(databaseName));
});

test("acquire derives the role without a lease", async () => {
  const databaseName = buildDatabaseName(resolveWorktreeIdentity(root), "dev");

  const { acquire } = await import("../src/core/lifecycle.ts");
  const result = await acquire({ root, mode: "dev", setEnv: false });

  expect(result.roleName).toBe(buildRoleName(databaseName));
});
