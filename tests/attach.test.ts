import { expect, test, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLease, type Lease } from "../src/core/lease.ts";

function makeLease(partial: Partial<Lease> & Pick<Lease, "root" | "port">): Lease {
  return {
    schemaVersion: 1,
    mode: "dev",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    databaseName: "cpg_cedar_main_dev_abcd1234",
    roleName: "cpg_cedar_main_dev_abcd1234_role",
    pid: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") resolve({ server, port: address.port });
      else reject(new Error("no TCP address"));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Any acquire / DDL / host start is a test failure: attach must never reach them. */
async function withNoAcquire<T>(run: () => Promise<T>): Promise<T> {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-reg-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  const forbidden = (name: string) =>
    vi.fn(async () => {
      throw new Error(`attach must not call ${name}`);
    });
  vi.resetModules();
  vi.doMock("../src/providers/host.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/host.ts")>(
      "../src/providers/host.ts",
    );
    return { ...actual, ensureHostRunning: forbidden("ensureHostRunning") };
  });
  vi.doMock("../src/providers/autopg.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/providers/autopg.ts")>(
      "../src/providers/autopg.ts",
    );
    return {
      ...actual,
      ensureDatabase: forbidden("ensureDatabase"),
      dropDatabasesOwnedByRole: forbidden("dropDatabasesOwnedByRole"),
    };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/providers/host.ts");
    vi.doUnmock("../src/providers/autopg.ts");
    vi.resetModules();
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
  }
}

test("attach returns the lease URL when the host listens, without acquiring", async () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const { server, port } = await listen();
  try {
    await withNoAcquire(async () => {
      const lease = makeLease({ root, port });
      writeLease(lease);
      const { attach, urlFromLease } = await import("../src/core/lifecycle.ts");
      await expect(attach({ root, mode: "dev" })).resolves.toEqual({
        lease,
        databaseUrl: urlFromLease(lease),
      });
    });
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach fails clearly without a lease (never acquires)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  try {
    await withNoAcquire(async () => {
      const { attach } = await import("../src/core/lifecycle.ts");
      await expect(attach({ root, mode: "test" })).rejects.toThrow(
        /no test lease .*cedarpg acquire --mode=test.*attach never acquires/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach fails clearly when nothing listens on the leased port (no revive)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-wt-"));
  const { server, port } = await listen();
  await close(server);
  try {
    await withNoAcquire(async () => {
      writeLease(makeLease({ root, port }));
      const { attach } = await import("../src/core/lifecycle.ts");
      await expect(attach({ root, mode: "dev" })).rejects.toThrow(
        new RegExp(`127\\.0\\.0\\.1:${port}, but nothing is listening`),
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
