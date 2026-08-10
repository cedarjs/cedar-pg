import type { Plugin, ViteDevServer } from "vite";
import { CLI_NAME } from "../core/constants.ts";
import { formatDevStatus, resolveDevStatus } from "../core/status.ts";
import type { DbMode } from "../core/naming.ts";
import { detectStudio, openStudio, type StudioKind } from "./studio.ts";

export type CedarPgDevOptions = {
  mode?: DbMode;
  root?: string;
  /** Force Prisma/Drizzle Studio; `false` disables the `p` shortcut. Omit to auto-detect. */
  studio?: StudioKind | false;
};

function shouldShowPanel(): boolean {
  return Boolean(process.stdin.isTTY) && !process.env.CI;
}

function logStatus(server: ViteDevServer, options: CedarPgDevOptions): void {
  const status = resolveDevStatus({ root: options.root, mode: options.mode ?? "dev" });
  for (const line of formatDevStatus(status)) {
    server.config.logger.info(line);
  }
}

function tryOpenStudio(server: ViteDevServer, options: CedarPgDevOptions): void {
  if (options.studio === false) {
    server.config.logger.warn(`${CLI_NAME}: studio shortcut disabled`);
    return;
  }

  const status = resolveDevStatus({ root: options.root, mode: options.mode ?? "dev" });
  if (!status.ok) {
    for (const line of formatDevStatus(status)) {
      server.config.logger.warn(line);
    }
    return;
  }

  const studio = detectStudio({ root: status.root, prefer: options.studio });
  if (!studio) {
    server.config.logger.warn(
      `${CLI_NAME}: no Prisma or Drizzle Studio found (install prisma or drizzle-kit)`,
    );
    return;
  }

  openStudio({ root: status.root, databaseUrl: status.databaseUrl, studio });
  server.config.logger.info(
    `${CLI_NAME}: opening ${studio.kind} studio (${studio.command} ${studio.args.join(" ")})`,
  );
}

/**
 * Vite / Vite+ plugin: print a cedar-pg status panel on listen and register
 * CLI shortcuts (`d` status, `p` studio). Does **not** acquire — pair with
 * `cedarPgTasks()` / `dependsOn: ['db:acquire']`.
 */
export function cedarPgDev(options: CedarPgDevOptions = {}): Plugin {
  return {
    name: "cedar-pg-dev",
    configureServer(server) {
      if (shouldShowPanel()) {
        const print = (): void => {
          logStatus(server, options);
        };
        if (server.httpServer) {
          server.httpServer.once("listening", print);
        } else {
          // Middleware mode / late bind: still allow shortcuts; panel on demand via `d`.
        }
      }

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
          key: "p",
          description: "open Prisma/Drizzle studio (cedar-pg DATABASE_URL)",
          action(s: ViteDevServer) {
            tryOpenStudio(s, options);
          },
        });
      }

      server.bindCLIShortcuts({
        print: false,
        customShortcuts: shortcuts,
      });
    },
  };
}
