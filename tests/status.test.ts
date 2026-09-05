import { expect, test } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLease, type Lease } from "../src/core/lease.ts";
import { formatDevStatus } from "../src/adapters/status-format.ts";
import { resolveDevStatus } from "../src/core/status.ts";

function makeLease(partial: Partial<Lease> & Pick<Lease, "root" | "databaseName" | "mode">): Lease {
  return {
    schemaVersion: 1,
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    roleName: `${partial.databaseName}_role`,
    port: 54321,
    pid: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("resolveDevStatus returns no-lease when missing", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-status-"));
  try {
    const status = resolveDevStatus({ root, mode: "dev" });
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.mode).toBe("dev");
    expect(status.root).toBe(root);
    expect("reason" in status).toBe(false);
    const lines = formatDevStatus(status);
    expect(lines.some((l) => l.includes("no dev lease"))).toBe(true);
    expect(lines.some((l) => l.includes("acquire"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDevStatus + formatDevStatus include url and env path", () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-status-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-status-wt-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  try {
    const lease = makeLease({
      root,
      mode: "dev",
      databaseName: "cpg_cedar_main_dev_abcd1234",
    });
    writeLease(lease);
    const status = resolveDevStatus({ root, mode: "dev" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.databaseUrl).toContain("cpg_cedar_main_dev_abcd1234");
    expect(status.databaseUrl).toContain(":54321/");
    expect(status.envPath).toBe(join(root, ".cedarpg", "dev.env"));
    const lines = formatDevStatus(status);
    expect(lines[0]).toContain("cpg_cedar_main_dev_abcd1234");
    expect(lines.some((l) => l.includes("DATABASE_URL"))).toBe(true);
    expect(lines.some((l) => l.includes("dev.env"))).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
