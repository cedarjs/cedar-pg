import { createRequire } from "node:module";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAttached } from "./child.ts";

export type StudioKind = "prisma" | "drizzle";

const STUDIO_PACKAGE: Record<StudioKind, string> = {
  prisma: "prisma",
  drizzle: "drizzle-kit",
};

const AUTO_ORDER: StudioKind[] = ["prisma", "drizzle"];

export type DetectStudioOptions = {
  /** Worktree / lease root — directory walk stops here. */
  root: string;
  /** App package to start the walk (Nx `apps/…`). Defaults to `root`. */
  cwd?: string;
  /** Force a kind. Omit to auto-detect (nearest package; prisma if both). */
  prefer?: StudioKind;
};

export type DetectedStudio = {
  kind: StudioKind;
  command: string;
  args: string[];
  /** Directory to spawn in (where the ORM package / config was found). */
  cwd: string;
  /** True when falling back to `npx`. */
  shell: boolean;
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

function npxStudio(kind: StudioKind, cwd: string): DetectedStudio {
  return {
    kind,
    command: "npx",
    args: [STUDIO_PACKAGE[kind], "studio"],
    cwd,
    shell: true,
  };
}

/** Local bin, else declared dep → npx, else null. Resolves the bin at most once. */
function studioAt(kind: StudioKind, dir: string): DetectedStudio | null {
  const pkg = STUDIO_PACKAGE[kind];
  const bin = tryResolveBin(dir, pkg);
  if (bin) return { kind, command: bin, args: ["studio"], cwd: dir, shell: false };
  if (hasDep(readPackageJson(dir), pkg)) return npxStudio(kind, dir);
  return null;
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

/**
 * Detect Prisma Studio or Drizzle Kit Studio, walking from `cwd` up to the worktree `root`.
 *
 * Auto: nearest directory wins, prisma before drizzle in that directory; no npx fallback.
 * Forced `prefer`: same nearest walk for that kind only, then npx at `cwd`.
 */
export function detectStudio(options: DetectStudioOptions): DetectedStudio | null {
  const stop = resolve(options.root);
  const start = resolve(options.cwd ?? options.root);
  const dirs = searchDirs(start, stop);
  const kinds = options.prefer ? [options.prefer] : AUTO_ORDER;

  for (const dir of dirs) {
    for (const kind of kinds) {
      const hit = studioAt(kind, dir);
      if (hit) return hit;
    }
  }
  return options.prefer ? npxStudio(options.prefer, start) : null;
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
    shell: studio.shell,
  });
}

/**
 * Detached Studio for the Vite shortcut. Caller attaches `error` / `exit` on the
 * returned process (spawn failures emit on a later tick).
 */
export function openStudio(options: SpawnStudioOptions): ChildProcess {
  const child = spawnStudio(options, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

/** Attached Studio for `cedarpg studio`: inherit stdio, resolve with the child's exit code. */
export function runStudio(options: SpawnStudioOptions): Promise<number> {
  const { databaseUrl, studio } = options;
  return runAttached(studio.command, studio.args, {
    cwd: studio.cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: studio.shell,
  });
}

export function studioChildRunning(child: ChildProcess | undefined): boolean {
  return Boolean(child && child.exitCode === null && !child.killed);
}
