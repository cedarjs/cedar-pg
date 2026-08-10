import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type StudioKind = "prisma" | "drizzle";

export type DetectStudioOptions = {
  root: string;
  /** Force a kind; `false` disables. Omit to auto-detect (prisma wins if both). */
  prefer?: StudioKind | false;
};

export type DetectedStudio = {
  kind: StudioKind;
  /** Absolute path to the CLI entry, or null when falling back to npx. */
  bin: string | null;
  command: string;
  args: string[];
};

type PkgJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readPackageJson(root: string): PkgJson | null {
  const file = join(root, "package.json");
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

function tryResolveBin(root: string, packageName: string): string | null {
  try {
    const require = createRequire(pathToFileURL(join(root, "package.json")).href);
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

function prismaCommand(root: string): DetectedStudio {
  const bin = tryResolveBin(root, "prisma");
  if (bin) return { kind: "prisma", bin, command: bin, args: ["studio"] };
  return { kind: "prisma", bin: null, command: "npx", args: ["prisma", "studio"] };
}

function drizzleCommand(root: string): DetectedStudio {
  const bin = tryResolveBin(root, "drizzle-kit");
  if (bin) return { kind: "drizzle", bin, command: bin, args: ["studio"] };
  return { kind: "drizzle", bin: null, command: "npx", args: ["drizzle-kit", "studio"] };
}

function packagePresent(root: string, name: string): boolean {
  return hasDep(readPackageJson(root), name) || Boolean(tryResolveBin(root, name));
}

/** Detect Prisma Studio or Drizzle Kit Studio from the project root. */
export function detectStudio(options: DetectStudioOptions): DetectedStudio | null {
  if (options.prefer === false) return null;

  if (options.prefer === "prisma") return prismaCommand(options.root);
  if (options.prefer === "drizzle") return drizzleCommand(options.root);

  // Auto: prefer prisma when both present.
  if (packagePresent(options.root, "prisma")) return prismaCommand(options.root);
  if (packagePresent(options.root, "drizzle-kit")) return drizzleCommand(options.root);
  return null;
}

export type OpenStudioOptions = {
  root: string;
  databaseUrl: string;
  studio: DetectedStudio;
};

/**
 * Spawn Studio detached with DATABASE_URL from the cedar-pg lease.
 * Returns the child process; caller may ignore it.
 */
export function openStudio(options: OpenStudioOptions): ChildProcess {
  const { root, databaseUrl, studio } = options;
  const child = spawn(studio.command, studio.args, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    detached: true,
    stdio: "ignore",
    shell: studio.bin === null,
  });
  child.unref();
  return child;
}
