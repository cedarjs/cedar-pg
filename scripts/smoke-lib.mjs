/**
 * Shared pack → temp consumer install helpers for smoke / smoke:pg.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
export const PACKAGE_NAME = pkg.name;
/** npm pack turns `@scope/name` into `scope-name-version.tgz` */
export const TARBALL_PREFIX = PACKAGE_NAME.replace(/^@/, "").replace("/", "-");
export const CLI_BIN = Object.keys(pkg.bin ?? {})[0] ?? "cedarpg";

export function run(cmd, args, { cwd = ROOT, silent = false, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: silent ? "pipe" : "inherit",
    env: env ?? process.env,
  });
  if (result.status !== 0) {
    if (silent && result.stderr) process.stderr.write(result.stderr);
    if (silent && result.stdout) process.stdout.write(result.stdout);
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status ?? "null"})`);
  }
  return result;
}

/** Remove leftover pack artifacts from a prior run. */
export function clearPackedTarballs() {
  for (const name of readdirSync(ROOT)) {
    if (name.startsWith(`${TARBALL_PREFIX}-`) && name.endsWith(".tgz")) {
      rmSync(join(ROOT, name), { force: true });
    }
  }
}

/** `pnpm pack` into repo root; returns absolute tarball path. */
export function packTarball() {
  console.log("==> pnpm pack");
  run("pnpm", ["pack", "--pack-destination", ROOT], { silent: true });
  const tarballName = readdirSync(ROOT).find(
    (name) => name.startsWith(`${TARBALL_PREFIX}-`) && name.endsWith(".tgz"),
  );
  if (!tarballName) {
    throw new Error(`pnpm pack failed to produce ${TARBALL_PREFIX}-*.tgz`);
  }
  const tarballPath = join(ROOT, tarballName);
  console.log(`    packed ${tarballPath}`);
  return tarballPath;
}

/**
 * Create a temp consumer dir, write package.json, install the tarball (+ extras).
 * Registers exit/SIGINT cleanup for tmp + tarball.
 */
export function installConsumer({ tarballPath, tmpPrefix, packageJson, npmPackages = [] }) {
  const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
  const cleanup = () => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  console.log(`==> install tarball into ${tmp}`);
  writeFileSync(join(tmp, "package.json"), JSON.stringify(packageJson, null, 2));
  run("npm", ["install", tarballPath, ...npmPackages, "--legacy-peer-deps"], {
    cwd: tmp,
    silent: true,
    env: { ...process.env, CEDAR_PG_SKIP_POSTINSTALL: "1" },
  });
  return tmp;
}

/** Ensure `~/.local/bin/autopg` via binary-only ci-install (never install.sh / pm2). */
export function ensureAutopgBinary(env = process.env) {
  const localBin = join(env.HOME ?? "", ".local", "bin");
  const pathEnv = {
    ...env,
    PATH: `${localBin}${env.PATH ? `:${env.PATH}` : ""}`,
  };
  const which = spawnSync("autopg", ["--help"], {
    encoding: "utf8",
    stdio: "pipe",
    env: pathEnv,
  });
  if (which.status === 0) return pathEnv;

  console.log("==> autopg missing; running scripts/ci-install-autopg.sh");
  run("bash", [join(ROOT, "scripts/ci-install-autopg.sh")], { env: pathEnv });
  return pathEnv;
}
