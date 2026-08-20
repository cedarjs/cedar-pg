import { expect, test, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ViteDevServer } from "vite";
import { writeLease, type Lease } from "../src/core/lease.ts";
import { cedarPgDev } from "../src/adapters/vite-plus.ts";

function invokeConfigureServer(
  plugin: ReturnType<typeof cedarPgDev>,
  server: Pick<ViteDevServer, "httpServer" | "config" | "bindCLIShortcuts">,
): void {
  const hook = plugin.configureServer;
  if (typeof hook !== "function") {
    throw new Error("expected configureServer function");
  }
  (hook as unknown as (s: typeof server) => void)(server);
}

type Shortcut = {
  key: string;
  description: string;
  action: (s: ViteDevServer) => void;
};

function shortcutsOf(bindCLIShortcuts: ReturnType<typeof vi.fn>): Shortcut[] {
  return bindCLIShortcuts.mock.calls[0]![0].customShortcuts as Shortcut[];
}

function mockServer(root: string, bindCLIShortcuts: ReturnType<typeof vi.fn>) {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const server = {
    httpServer: new EventEmitter(),
    config: { root, logger: { info, warn, error } },
    bindCLIShortcuts,
  };
  return { server, info, warn, error };
}

test("cedarPgDev registers d and s shortcuts without printing help", () => {
  const bindCLIShortcuts = vi.fn();
  const { server } = mockServer("/tmp", bindCLIShortcuts);

  const plugin = cedarPgDev();
  expect(plugin.name).toBe("cedar-pg-dev");
  invokeConfigureServer(plugin, server as never);

  expect(bindCLIShortcuts).toHaveBeenCalledWith(
    expect.objectContaining({
      print: false,
      customShortcuts: expect.any(Array),
    }),
  );
  expect(
    shortcutsOf(bindCLIShortcuts)
      .map((s) => s.key)
      .sort(),
  ).toEqual(["d", "s"]);
});

test("cedarPgDev omits s shortcut when studio is false", () => {
  const bindCLIShortcuts = vi.fn();
  const server = {
    httpServer: null,
    config: { root: "/tmp", logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    bindCLIShortcuts,
  };
  invokeConfigureServer(cedarPgDev({ studio: false }), server as never);
  expect(shortcutsOf(bindCLIShortcuts).map((s) => s.key)).toEqual(["d"]);
});

test("d shortcut warns when there is no lease", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-dev-nolease-"));
  const bindCLIShortcuts = vi.fn();
  const { server, info, warn } = mockServer(root, bindCLIShortcuts);
  try {
    invokeConfigureServer(cedarPgDev({ root }), server as never);
    const d = shortcutsOf(bindCLIShortcuts).find((s) => s.key === "d");
    d!.action(server as never);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no dev lease"))).toBe(true);
    expect(info).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("d shortcut info-logs an existing lease", () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-dev-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-dev-lease-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  const bindCLIShortcuts = vi.fn();
  const { server, info, warn } = mockServer(root, bindCLIShortcuts);
  try {
    const lease: Lease = {
      schemaVersion: 1,
      root,
      mode: "dev",
      databaseName: "cpg_cedar_main_dev_abcd1234",
      repoSlug: "cedar",
      worktreeSlug: "main",
      pathHash: "abcd1234",
      roleName: "cpg_cedar_main_dev_abcd1234_role",
      port: 54321,
      pid: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    writeLease(lease);
    invokeConfigureServer(cedarPgDev({ root }), server as never);
    const d = shortcutsOf(bindCLIShortcuts).find((s) => s.key === "d");
    d!.action(server as never);
    expect(info.mock.calls.some((c) => String(c[0]).includes("cpg_cedar_main_dev_abcd1234"))).toBe(
      true,
    );
    expect(warn).not.toHaveBeenCalled();
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("s shortcut warns when no ORM is installed", () => {
  const registry = mkdtempSync(join(tmpdir(), "cedarpg-dev-s-reg-"));
  const root = mkdtempSync(join(tmpdir(), "cedarpg-dev-s-"));
  const prev = process.env.CEDAR_PG_REGISTRY_DIR;
  process.env.CEDAR_PG_REGISTRY_DIR = registry;
  const bindCLIShortcuts = vi.fn();
  const { server, warn } = mockServer(root, bindCLIShortcuts);
  try {
    writeLease({
      schemaVersion: 1,
      root,
      mode: "dev",
      databaseName: "cpg_cedar_main_dev_abcd1234",
      repoSlug: "cedar",
      worktreeSlug: "main",
      pathHash: "abcd1234",
      roleName: "cpg_cedar_main_dev_abcd1234_role",
      port: 54321,
      pid: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    invokeConfigureServer(cedarPgDev({ root }), server as never);
    const s = shortcutsOf(bindCLIShortcuts).find((sc) => sc.key === "s");
    s!.action(server as never);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no Prisma or Drizzle"))).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_REGISTRY_DIR;
    else process.env.CEDAR_PG_REGISTRY_DIR = prev;
    rmSync(registry, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
