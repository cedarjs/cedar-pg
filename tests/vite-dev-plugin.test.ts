import { expect, test, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import type { ViteDevServer } from "vite";
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

test("cedarPgDev registers d and p shortcuts without printing help", () => {
  const bindCLIShortcuts = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const httpServer = new EventEmitter();

  const server = {
    httpServer,
    config: { logger: { info, warn } },
    bindCLIShortcuts,
  };

  const plugin = cedarPgDev();
  expect(plugin.name).toBe("cedar-pg-dev");
  invokeConfigureServer(plugin, server as never);

  expect(bindCLIShortcuts).toHaveBeenCalledWith(
    expect.objectContaining({
      print: false,
      customShortcuts: expect.any(Array),
    }),
  );
  const shortcuts = bindCLIShortcuts.mock.calls[0]![0].customShortcuts as Array<{
    key: string;
    description: string;
  }>;
  expect(shortcuts.map((s) => s.key).sort()).toEqual(["d", "p"]);
});

test("cedarPgDev omits p shortcut when studio is false", () => {
  const bindCLIShortcuts = vi.fn();
  const server = {
    httpServer: null,
    config: { logger: { info: vi.fn(), warn: vi.fn() } },
    bindCLIShortcuts,
  };
  invokeConfigureServer(cedarPgDev({ studio: false }), server as never);
  const shortcuts = bindCLIShortcuts.mock.calls[0]![0].customShortcuts as Array<{ key: string }>;
  expect(shortcuts.map((s) => s.key)).toEqual(["d"]);
});
