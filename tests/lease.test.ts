import { expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLease,
  envPath,
  isOrphanLease,
  listRegistryLeases,
  parseLease,
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

test("parseLease rejects incomplete records", () => {
  expect(parseLease(null)).toBeNull();
  expect(parseLease({ schemaVersion: 1 })).toBeNull();
  expect(
    parseLease(
      makeLease({
        root: "/tmp/wt",
        databaseName: "cpg_cedar_main_test_abcd1234",
      }),
    ),
  ).not.toBeNull();
});

test("writeLease / readLease round-trip and register for gc", () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  try {
    const lease = makeLease({
      root,
      databaseName: "cpg_cedar_main_test_abcd1234",
    });
    writeLease(lease);
    writeFileSync(envPath(root, "test"), "DATABASE_URL=postgresql://u:p@127.0.0.1:1/db\n", {
      mode: 0o600,
    });
    expect(readLease(root, "test")).toEqual(lease);
    expect(listRegistryLeases().map((l) => l.databaseName)).toContain(lease.databaseName);
    expect(isOrphanLease(lease)).toBe(false);
    expect(existsSync(envPath(root, "test"))).toBe(true);

    clearLease(root, "test");
    expect(readLease(root, "test")).toBeNull();
    expect(existsSync(envPath(root, "test"))).toBe(false);
    expect(listRegistryLeases().map((l) => l.databaseName)).not.toContain(lease.databaseName);
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("isOrphanLease is true when root is missing", () => {
  const lease = makeLease({
    root: join(tmpdir(), "cedarpg-missing-root-" + Date.now()),
    databaseName: "cpg_cedar_gone_test_deadbeef",
  });
  expect(isOrphanLease(lease)).toBe(true);
});

test("readLease returns null for corrupt files", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-bad-"));
  try {
    mkdirSync(join(root, ".cedarpg"), { recursive: true });
    writeFileSync(join(root, ".cedarpg", "test.json"), "{not json");
    expect(readLease(root, "test")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearLease unregisters by peeked databaseName when full parse fails", () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  try {
    const lease = makeLease({
      root,
      databaseName: "cpg_cedar_main_test_peekname",
    });
    writeLease(lease);
    // Corrupt schema so parseLease fails, but databaseName remains peekable
    writeFileSync(
      join(root, ".cedarpg", "test.json"),
      JSON.stringify({ schemaVersion: 99, databaseName: lease.databaseName }),
    );
    writeFileSync(envPath(root, "test"), "DATABASE_URL=postgresql://stale\n", { mode: 0o600 });
    expect(readLease(root, "test")).toBeNull();
    clearLease(root, "test");
    expect(existsSync(envPath(root, "test"))).toBe(false);
    expect(listRegistryLeases().map((l) => l.databaseName)).not.toContain(lease.databaseName);
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
