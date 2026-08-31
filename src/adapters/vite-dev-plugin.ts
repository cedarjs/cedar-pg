import type { ChildProcess } from "node:child_process";
import type { Plugin, ViteDevServer } from "vite";
import { version as viteVersion } from "vite";
import { CLI_NAME } from "../core/constants.ts";
import { formatDevStatus, resolveDevStatus } from "../core/status.ts";
import type { DbMode } from "../core/naming.ts";
import { detectStudio, openStudio, studioChildRunning, type StudioKind } from "./studio.ts";

export function viteBindsPluginShortcuts(version: string = viteVersion): boolean {
  return Number.parseInt(version, 10) >= 8;
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

function logStatus(server: ViteDevServer, options: CedarPgDevOptions): void {
  const status = resolveDevStatus({ root: options.root, mode: options.mode ?? "dev" });
  for (const line of formatDevStatus(status)) {
    if (status.ok) server.config.logger.info(line);
    else server.config.logger.warn(line);
  }
}

/**
 * Vite / Vite+ plugin: print a cedar-pg status panel on listen and register
 * CLI shortcuts (`d` status, `s` studio) on Vite 8+. Does **not** acquire —
 * pair with `cedarPgTasks()` / `dependsOn: ['db:acquire']`.
 */
export function cedarPgDev(options: CedarPgDevOptions = {}): Plugin {
  return {
    name: "cedar-pg-dev",
    configureServer(server) {
      if (shouldShowPanel() && server.httpServer) {
        server.httpServer.once("listening", () => {
          logStatus(server, options);
        });
      }

      let studioChild: ChildProcess | undefined;

      const tryOpenStudio = (s: ViteDevServer): void => {
        const status = resolveDevStatus({ root: options.root, mode: options.mode ?? "dev" });
        if (!status.ok) {
          for (const line of formatDevStatus(status)) {
            s.config.logger.warn(line);
          }
          return;
        }

        const studio = detectStudio({
          root: status.root,
          cwd: options.cwd ?? s.config.root,
          prefer: options.studio,
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

        studioChild = openStudio(
          { databaseUrl: status.databaseUrl, studio },
          {
            onError(err) {
              studioChild = undefined;
              s.config.logger.error(`${CLI_NAME}: studio failed: ${err.message}`);
            },
            onExit(code, signal) {
              studioChild = undefined;
              if (code && code !== 0) {
                s.config.logger.warn(`${CLI_NAME}: studio exited ${code}`);
              } else if (signal) {
                s.config.logger.warn(`${CLI_NAME}: studio killed (${signal})`);
              }
            },
          },
        );
        s.config.logger.info(
          `${CLI_NAME}: opening ${studio.kind} studio (${studio.command} ${studio.args.join(" ")})`,
        );
      };

      const shortcuts = [
        {
          key: "d",
          description: "show cedar-pg database status",
          action(s: ViteDevServer) {
            logStatus(s, options);
          },
        },
      ];

      if (options.studio !== false) {
        shortcuts.push({
          key: "s",
          description: "open Prisma/Drizzle studio (cedar-pg DATABASE_URL)",
          action: tryOpenStudio,
        });
      }

      if (viteBindsPluginShortcuts()) {
        server.bindCLIShortcuts({
          print: false,
          customShortcuts: shortcuts,
        });
      }
    },
  };
}
