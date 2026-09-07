import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import type { Plugin, ViteDevServer } from "vite";
import { CLI_NAME } from "../core/constants.ts";
import { resolveDevStatus, type DevStatus } from "../core/status.ts";
import type { DbMode } from "../core/naming.ts";
import { formatDevStatus } from "./status-format.ts";
import { detectStudio, openStudio, studioChildRunning, type StudioKind } from "./studio.ts";

const requireVite = createRequire(import.meta.url);

function installedViteVersion(): string | undefined {
  try {
    return (requireVite("vite/package.json") as { version: string }).version;
  } catch {
    return undefined;
  }
}

export function viteBindsPluginShortcuts(version?: string): boolean {
  const resolved = version ?? installedViteVersion();
  if (resolved === undefined) return false;
  return Number.parseInt(resolved, 10) >= 8;
}

export type CedarPgDevOptions = {
  mode?: DbMode;
  /** Worktree / lease root. Omit to resolve from cwd (git toplevel). */
  root?: string;
  /** App package to search for Prisma/Drizzle. Defaults to Vite `config.root`. */
  cwd?: string;
  /** Force Prisma/Drizzle Studio; `false` disables the `s` shortcut. Omit to auto-detect. */
  studio?: StudioKind | false;
};

function shouldShowPanel(): boolean {
  return Boolean(process.stdin.isTTY) && !process.env.CI;
}

function logStatus(server: ViteDevServer, options: CedarPgDevOptions): DevStatus {
  const status = resolveDevStatus({ root: options.root, mode: options.mode });
  for (const line of formatDevStatus(status)) {
    if (status.ok) server.config.logger.info(line);
    else server.config.logger.warn(line);
  }
  return status;
}

function createStudioLauncher(options: CedarPgDevOptions): (s: ViteDevServer) => void {
  let studioChild: ChildProcess | undefined;
  const prefer = options.studio === false ? undefined : options.studio;
  return (s) => {
    const status = logStatus(s, options);
    if (!status.ok) return;

    const studio = detectStudio({
      root: status.root,
      cwd: options.cwd ?? s.config.root,
      prefer,
    });
    if (!studio) {
      s.config.logger.warn(
        `${CLI_NAME}: no Prisma or Drizzle Studio found (install prisma or drizzle-kit)`,
      );
      return;
    }

    if (studioChildRunning(studioChild)) {
      s.config.logger.info(`${CLI_NAME}: studio already running`);
      return;
    }

    const child = openStudio({ databaseUrl: status.databaseUrl, studio });
    child.once("error", (err) => {
      studioChild = undefined;
      s.config.logger.error(`${CLI_NAME}: studio failed: ${err.message}`);
    });
    child.once("exit", (code, signal) => {
      studioChild = undefined;
      if (code && code !== 0) {
        s.config.logger.warn(`${CLI_NAME}: studio exited ${code}`);
      } else if (signal) {
        s.config.logger.warn(`${CLI_NAME}: studio killed (${signal})`);
      }
    });
    studioChild = child;
    s.config.logger.info(
      `${CLI_NAME}: opening ${studio.kind} studio (${studio.command} ${studio.args.join(" ")})`,
    );
  };
}

/**
 * Vite / Vite+ plugin: print a cedar-pg status panel on listen and register
 * CLI shortcuts (`d` status, `s` studio) on Vite 8+. Does **not** acquire —
 * pair with `cedarPgTasks()` / `dependsOn: ['db:acquire']`.
 *
 * @param viteVersion Test-only override for the shortcut gate. Omit in production.
 */
export function cedarPgDev(options: CedarPgDevOptions = {}, viteVersion?: string): Plugin {
  return {
    name: "cedar-pg-dev",
    configureServer(server) {
      if (shouldShowPanel() && server.httpServer) {
        server.httpServer.once("listening", () => {
          logStatus(server, options);
        });
      }

      if (!viteBindsPluginShortcuts(viteVersion)) {
        return;
      }

      const dShortcut = {
        key: "d",
        description: "show cedar-pg database status",
        action(s: ViteDevServer) {
          logStatus(s, options);
        },
      };
      const shortcuts =
        options.studio === false
          ? [dShortcut]
          : [
              dShortcut,
              {
                key: "s",
                description: "open Prisma/Drizzle studio (cedar-pg DATABASE_URL)",
                action: createStudioLauncher(options),
              },
            ];

      server.bindCLIShortcuts({
        print: false,
        customShortcuts: shortcuts,
      });
    },
  };
}
