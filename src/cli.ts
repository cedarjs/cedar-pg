#!/usr/bin/env node
import { ensure, dispose, gc } from "./core/lifecycle.ts";
import { resolveWorktreeIdentity } from "./core/worktree.ts";
import { buildDatabaseName } from "./core/naming.ts";
import { readLease } from "./core/lease.ts";
import type { DbMode } from "./core/naming.ts";
import { buildDatabaseUrl, discoverHost } from "./providers/autopg.ts";

function printHelp(): void {
  process.stdout.write(`cedar-pg — worktree-isolated local Postgres (via autopg)

Usage:
  cedar-pg ensure --mode=dev|test [--root <path>] [--json] [--print-env]
  cedar-pg dispose [--mode=dev|test] [--root <path>]
  cedar-pg gc [--root <path>] [--json]
  cedar-pg print-url [--mode=dev|test] [--root <path>]
  cedar-pg --help

Modes:
  dev   Keep DB across restarts (default for ensure if omitted: dev)
  test  Drop DB on dispose / test teardown

Env:
  AUTOPG_BIN     Path to autopg binary
  CEDAR_PG=0     Disable adapters that auto-ensure
`);
}

function parseArgs(argv: string[]) {
  const out: {
    cmd?: string;
    mode?: DbMode;
    root?: string;
    json?: boolean;
    printEnv?: boolean;
    help?: boolean;
  } = {};
  const rest = [...argv];
  out.cmd = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--print-env") out.printEnv = true;
    else if (a.startsWith("--mode=")) out.mode = a.slice(7) as DbMode;
    else if (a === "--mode") out.mode = rest[++i] as DbMode;
    else if (a.startsWith("--root=")) out.root = a.slice(7);
    else if (a === "--root") out.root = rest[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
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
    if (args.cmd === "ensure") {
      const mode = args.mode ?? "dev";
      if (mode !== "dev" && mode !== "test") {
        throw new Error("--mode must be dev or test");
      }
      const result = await ensure({
        root: args.root,
        mode,
        disposeOnExit: false,
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
          `cedar-pg: ${result.databaseName} (${result.repoSlug}/${result.worktreeSlug} ${result.mode})\n`,
        );
        process.stdout.write(`${result.databaseUrl}\n`);
      }
      return 0;
    }

    if (args.cmd === "dispose") {
      const mode = args.mode ?? "test";
      await dispose({ root: args.root, mode });
      process.stdout.write(`cedar-pg: disposed ${mode}\n`);
      return 0;
    }

    if (args.cmd === "gc") {
      const result = await gc({ root: args.root });
      if (args.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        process.stdout.write(`cedar-pg gc: dropped ${result.dropped.length} database(s)\n`);
        for (const name of result.dropped) process.stdout.write(`  ${name}\n`);
      }
      return 0;
    }

    if (args.cmd === "print-url") {
      const mode = args.mode ?? "dev";
      const identity = resolveWorktreeIdentity(args.root);
      const lease = readLease(identity.root, mode);
      const databaseName = lease?.databaseName ?? buildDatabaseName(identity, mode);
      if (lease) {
        const host = discoverHost();
        const url = buildDatabaseUrl({
          port: lease.port || host.port,
          databaseName,
          roleName: lease.roleName,
          socketDir: host.socketDir,
        });
        process.stdout.write(`${url}\n`);
      } else {
        process.stderr.write(
          `cedar-pg: no ${mode} lease — run \`cedar-pg ensure --mode=${mode}\` first\n`,
        );
        return 2;
      }
      return 0;
    }

    process.stderr.write(`cedar-pg: unknown command ${args.cmd}\n`);
    printHelp();
    return 64;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cedar-pg: ${message}\n`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cedar-pg: ${message}\n`);
    process.exit(1);
  });
