#!/usr/bin/env node
import { CLI_NAME } from "./core/constants.ts";
import { ensure, dispose, gc, urlFromLease } from "./core/lifecycle.ts";
import { resolveWorktreeIdentity } from "./core/worktree.ts";
import { readLease } from "./core/lease.ts";
import type { DbMode } from "./core/naming.ts";

function printHelp(): void {
  process.stdout.write(`${CLI_NAME}: worktree-isolated local Postgres (via autopg)

Usage:
  ${CLI_NAME} ensure --mode=dev|test [--root <path>] [--json] [--print-env]
  ${CLI_NAME} dispose [--mode=dev|test] [--root <path>]
  ${CLI_NAME} gc [--json]
  ${CLI_NAME} print-url [--mode=dev|test] [--root <path>]
  ${CLI_NAME} --help

Modes:
  dev   Keep DB across restarts (default for ensure if omitted: dev)
  test  Drop DB on dispose / test teardown

Env:
  AUTOPG_BIN     Path to autopg binary
  CEDAR_PG=0     Disable adapters that auto-ensure
`);
}

function parseMode(value: string | undefined): DbMode {
  if (value === "dev" || value === "test") return value;
  throw new Error("--mode must be dev or test");
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
    else if (a.startsWith("--mode=")) out.mode = parseMode(a.slice(7));
    else if (a === "--mode") out.mode = parseMode(rest[++i]);
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
      const result = await ensure({
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
          `${CLI_NAME}: no ${mode} lease; run \`${CLI_NAME} ensure --mode=${mode}\` first\n`,
        );
        return 2;
      }
      process.stdout.write(`${urlFromLease(lease)}\n`);
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
