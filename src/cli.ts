#!/usr/bin/env node
import { spawn } from "node:child_process";
import { CLI_NAME } from "./core/constants.ts";
import { acquire, dispose, gc, urlFromLease } from "./core/lifecycle.ts";
import { resolveWorktreeIdentity } from "./core/worktree.ts";
import { readLease } from "./core/lease.ts";
import { formatDevStatus, resolveDevStatus } from "./core/status.ts";
import type { DbMode } from "./core/naming.ts";
import { detectStudio, openStudio, type StudioKind } from "./adapters/studio.ts";

function printHelp(): void {
  process.stdout.write(`${CLI_NAME}: worktree-isolated local Postgres (via autopg)

Usage:
  ${CLI_NAME} acquire --mode=dev|test [--root <path>] [--force] [--json] [--print-env]
  ${CLI_NAME} run --mode=dev|test [--root <path>] [--force] -- <cmd…>
  ${CLI_NAME} dispose [--mode=dev|test] [--root <path>]
  ${CLI_NAME} gc [--json]
  ${CLI_NAME} print-url [--mode=dev|test] [--root <path>]
  ${CLI_NAME} status [--mode=dev|test] [--root <path>] [--json]
  ${CLI_NAME} studio [--mode=dev|test] [--root <path>] [--prisma|--drizzle]
  ${CLI_NAME} --help

Modes:
  dev   Keep DB across restarts (default when --mode omitted)
  test  Drop DB on dispose / test teardown

run:
  Acquire, set DATABASE_URL (+ TEST_DATABASE_URL in test) on the child, exec <cmd…>.
  --force sets CEDAR_PG_FORCE (escape hatch); child env overwrite is always on.

status / studio:
  Read-only lease inspection (no acquire). studio opens Prisma or Drizzle Kit Studio
  with DATABASE_URL from the lease (auto-detect; --prisma / --drizzle to force).

Env:
  AUTOPG_BIN       Path to autopg binary
  CEDAR_PG=0       Disable adapters that auto-acquire
  CEDAR_PG_FORCE=1 Ignore external-URL escape hatch (same as --force)
`);
}

function parseMode(value: string | undefined): DbMode {
  if (value === "dev" || value === "test") return value;
  throw new Error("--mode must be dev or test");
}

type ParsedArgs = {
  cmd?: string;
  mode?: DbMode;
  root?: string;
  json?: boolean;
  printEnv?: boolean;
  force?: boolean;
  help?: boolean;
  prisma?: boolean;
  drizzle?: boolean;
  child?: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  const rest = [...argv];
  out.cmd = rest.shift();

  const dash = rest.indexOf("--");
  let flagArgs = rest;
  if (dash >= 0) {
    flagArgs = rest.slice(0, dash);
    out.child = rest.slice(dash + 1);
  }

  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--print-env") out.printEnv = true;
    else if (a === "--force") out.force = true;
    else if (a === "--prisma") out.prisma = true;
    else if (a === "--drizzle") out.drizzle = true;
    else if (a.startsWith("--mode=")) out.mode = parseMode(a.slice(7));
    else if (a === "--mode") out.mode = parseMode(flagArgs[++i]);
    else if (a.startsWith("--root=")) out.root = a.slice(7);
    else if (a === "--root") out.root = flagArgs[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function studioPrefer(args: ParsedArgs): StudioKind | undefined {
  if (args.prisma && args.drizzle) {
    throw new Error("pass only one of --prisma or --drizzle");
  }
  if (args.prisma) return "prisma";
  if (args.drizzle) return "drizzle";
  return undefined;
}

function runChild(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [file, ...args] = command;
  if (!file) {
    throw new Error(
      `run requires a command after -- (e.g. ${CLI_NAME} run --mode=dev -- yarn dev)`,
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  try {
    if (args.cmd === "acquire") {
      if (args.force) process.env.CEDAR_PG_FORCE = "1";
      const mode = args.mode ?? "dev";
      const result = await acquire({
        root: args.root,
        mode,
        setEnv: true,
      });
      if (args.printEnv) {
        process.stdout.write(`DATABASE_URL=${result.databaseUrl}\n`);
        if (mode === "test") {
          process.stdout.write(`TEST_DATABASE_URL=${result.databaseUrl}\n`);
        }
      }
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              databaseUrl: result.databaseUrl,
              adminUrl: result.adminUrl,
              databaseName: result.databaseName,
              roleName: result.roleName,
              repoSlug: result.repoSlug,
              worktreeSlug: result.worktreeSlug,
              pathHash: result.pathHash,
              mode: result.mode,
              port: result.port,
              root: result.root,
            },
            null,
            2,
          )}\n`,
        );
      } else if (!args.printEnv) {
        process.stdout.write(
          `${CLI_NAME}: ${result.databaseName} (${result.repoSlug}/${result.worktreeSlug} ${result.mode})\n`,
        );
        process.stdout.write(`${result.databaseUrl}\n`);
      }
      return 0;
    }

    if (args.cmd === "run") {
      if (args.force) process.env.CEDAR_PG_FORCE = "1";
      const mode = args.mode ?? "dev";
      const result = await acquire({
        root: args.root,
        mode,
        setEnv: true,
      });
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: result.databaseUrl,
      };
      if (mode === "test") childEnv.TEST_DATABASE_URL = result.databaseUrl;
      return await runChild(args.child ?? [], childEnv);
    }

    if (args.cmd === "dispose") {
      const mode = args.mode ?? "test";
      const result = await dispose({ root: args.root, mode });
      if (result.dropped) {
        process.stdout.write(`${CLI_NAME}: disposed ${mode} (${result.databaseName})\n`);
        return 0;
      }
      if (result.reason === "no-lease") {
        process.stdout.write(`${CLI_NAME}: nothing to dispose for ${mode} (no lease)\n`);
        return 0;
      }
      process.stderr.write(
        `${CLI_NAME}: could not dispose ${mode}: autopg host unavailable (lease kept for retry)\n`,
      );
      return 1;
    }

    if (args.cmd === "gc") {
      const result = await gc();
      if (args.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        process.stdout.write(`${CLI_NAME} gc: dropped ${result.dropped.length} database(s)\n`);
        for (const name of result.dropped) process.stdout.write(`  ${name}\n`);
      }
      return 0;
    }

    if (args.cmd === "print-url") {
      const mode = args.mode ?? "dev";
      const identity = resolveWorktreeIdentity(args.root);
      const lease = readLease(identity.root, mode);
      if (!lease) {
        process.stderr.write(
          `${CLI_NAME}: no ${mode} lease; run \`${CLI_NAME} acquire --mode=${mode}\` first\n`,
        );
        return 2;
      }
      process.stdout.write(`${urlFromLease(lease)}\n`);
      return 0;
    }

    if (args.cmd === "status") {
      const mode = args.mode ?? "dev";
      const status = resolveDevStatus({ root: args.root, mode });
      if (args.json) {
        if (!status.ok) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, reason: status.reason, mode: status.mode, root: status.root }, null, 2)}\n`,
          );
          return 2;
        }
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              mode: status.mode,
              root: status.root,
              databaseUrl: status.databaseUrl,
              envPath: status.envPath,
              databaseName: status.lease.databaseName,
              roleName: status.lease.roleName,
              repoSlug: status.lease.repoSlug,
              worktreeSlug: status.lease.worktreeSlug,
              port: status.lease.port,
              createdAt: status.lease.createdAt,
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      for (const line of formatDevStatus(status)) {
        process.stdout.write(`${line}\n`);
      }
      return status.ok ? 0 : 2;
    }

    if (args.cmd === "studio") {
      const mode = args.mode ?? "dev";
      const prefer = studioPrefer(args);
      const status = resolveDevStatus({ root: args.root, mode });
      if (!status.ok) {
        for (const line of formatDevStatus(status)) {
          process.stderr.write(`${line}\n`);
        }
        return 2;
      }
      const studio = detectStudio({ root: status.root, prefer });
      if (!studio) {
        process.stderr.write(
          `${CLI_NAME}: no Prisma or Drizzle Studio found (install prisma or drizzle-kit)\n`,
        );
        return 1;
      }
      openStudio({ root: status.root, databaseUrl: status.databaseUrl, studio });
      process.stdout.write(
        `${CLI_NAME}: opening ${studio.kind} studio (${studio.command} ${studio.args.join(" ")})\n`,
      );
      return 0;
    }

    process.stderr.write(`${CLI_NAME}: unknown command ${args.cmd}\n`);
    printHelp();
    return 64;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${CLI_NAME}: ${message}\n`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${CLI_NAME}: ${message}\n`);
    process.exit(1);
  });
