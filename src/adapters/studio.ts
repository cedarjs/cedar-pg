import { createRequire } from "node:module";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type StudioKind = "prisma" | "drizzle";

export type DetectStudioOptions = {
  /** Worktree / lease root — directory walk stops here. */
  root: string;
  /** App package to start the walk (Nx `apps/…`). Defaults to `root`. */
  cwd?: string;
  /** Force a kind; `false` disables. Omit to auto-detect (nearest package; prisma if both). */
  prefer?: StudioKind | false;
};

export type DetectedStudio = {
  kind: StudioKind;
  /** Absolute path to the CLI entry, or null when falling back to npx. */
  bin: string | null;
  command: string;
  args: string[];
  /** Directory to spawn in (where the ORM package / config was found). */
  cwd: string;
};

type PkgJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readPackageJson(dir: string): PkgJson | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PkgJson;
  } catch {
    return null;
  }
}

function hasDep(pkg: PkgJson | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(
    pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name],
  );
}

function tryResolveBin(dir: string, packageName: string): string | null {
  try {
    const require = createRequire(pathToFileURL(join(dir, "package.json")).href);
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binField = pkg.bin;
    let rel: string | undefined;
    if (typeof binField === "string") rel = binField;
    else if (binField && typeof binField === "object") {
      rel = binField[packageName] ?? Object.values(binField)[0];
    }
    if (!rel) return null;
    const abs = join(dirname(pkgJsonPath), rel);
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

function prismaCommand(cwd: string): DetectedStudio {
  const bin = tryResolveBin(cwd, "prisma");
  if (bin) return { kind: "prisma", bin, command: bin, args: ["studio"], cwd };
  return { kind: "prisma", bin: null, command: "npx", args: ["prisma", "studio"], cwd };
}

function drizzleCommand(cwd: string): DetectedStudio {
  const bin = tryResolveBin(cwd, "drizzle-kit");
  if (bin) return { kind: "drizzle", bin, command: bin, args: ["studio"], cwd };
  return { kind: "drizzle", bin: null, command: "npx", args: ["drizzle-kit", "studio"], cwd };
}

function packagePresent(dir: string, name: string): boolean {
  return hasDep(readPackageJson(dir), name) || Boolean(tryResolveBin(dir, name));
}

function isInside(dir: string, ancestor: string): boolean {
  const rel = relative(ancestor, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `start` up to `stop` (inclusive) when `start` is inside the worktree; otherwise only `start`. */
function searchDirs(start: string, stop: string): string[] {
  if (!isInside(start, stop)) return [start];
  const dirs: string[] = [];
  let dir = start;
  for (;;) {
    dirs.push(dir);
    if (dir === stop) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

function firstKind(dirs: string[], name: "prisma" | "drizzle-kit"): DetectedStudio | null {
  for (const dir of dirs) {
    if (packagePresent(dir, name)) {
      return name === "prisma" ? prismaCommand(dir) : drizzleCommand(dir);
    }
  }
  return null;
}

/** Detect Prisma Studio or Drizzle Kit Studio, walking from `cwd` up to the worktree `root`. */
export function detectStudio(options: DetectStudioOptions): DetectedStudio | null {
  if (options.prefer === false) return null;

  const stop = resolve(options.root);
  const start = resolve(options.cwd ?? options.root);
  const dirs = searchDirs(start, stop);

  if (options.prefer === "prisma") return firstKind(dirs, "prisma") ?? prismaCommand(start);
  if (options.prefer === "drizzle") return firstKind(dirs, "drizzle-kit") ?? drizzleCommand(start);

  for (const dir of dirs) {
    if (packagePresent(dir, "prisma")) return prismaCommand(dir);
    if (packagePresent(dir, "drizzle-kit")) return drizzleCommand(dir);
  }
  return null;
}

export type SpawnStudioOptions = {
  databaseUrl: string;
  studio: DetectedStudio;
};

function spawnStudio(options: SpawnStudioOptions, spawnOpts: SpawnOptions): ChildProcess {
  const { databaseUrl, studio } = options;
  return spawn(studio.command, studio.args, {
    cwd: studio.cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    ...spawnOpts,
    shell: studio.bin === null,
  });
}

export type OpenStudioHooks = {
  onError?: (err: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

/**
 * Detached Studio for the Vite shortcut. Attach hooks before `unref` so spawn
 * failures are not uncaught (ENOENT would otherwise crash the dev server).
 */
export function openStudio(options: SpawnStudioOptions, hooks: OpenStudioHooks = {}): ChildProcess {
  const child = spawnStudio(options, { detached: true, stdio: "ignore" });
  child.once("error", (err) => {
    hooks.onError?.(err);
  });
  child.once("exit", (code, signal) => {
    hooks.onExit?.(code, signal);
  });
  child.unref();
  return child;
}

/** Attached Studio for `cedarpg studio`: inherit stdio, resolve with the child's exit code. */
export function runStudio(options: SpawnStudioOptions): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnStudio(options, { detached: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise(signal ? 1 : (code ?? 1));
    });
  });
}

export function studioChildRunning(child: ChildProcess | undefined): boolean {
  return Boolean(child && child.exitCode === null && !child.killed);
}
