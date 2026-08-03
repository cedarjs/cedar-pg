import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHost, INSTALL_HINT, requireAutopgBin, type AutopgDiscovery } from "./autopg.ts";

/** How cedar-pg starts an autopg host when none is already live. */
export type HostStartPolicy = "local" | "ephemeral";

/** Opinionated install + postmaster argv for CI / ephemeral runners. */
export type EphemeralHostRecipe = {
  dataDir: string;
  installArgs: string[];
  postmasterArgs: string[];
};

/** Inputs for {@link ephemeralHostRecipe} (production uses process defaults). */
export type EphemeralRecipeContext = {
  platform?: NodeJS.Platform;
  shmAvailable?: boolean;
  tmpDir?: string;
  uid?: number;
};

const OWNED_POSTMASTER_READY_MS = 30_000;
const OWNED_POSTMASTER_POLL_MS = 200;

/**
 * Resolve whether to start an owned ephemeral postmaster or use local pm2 install.
 *
 * - `CEDAR_PG_EPHEMERAL_HOST=1` → ephemeral
 * - `CEDAR_PG_EPHEMERAL_HOST=0` → local (even when `CI=true`)
 * - unset + `CI=true` → ephemeral
 * - otherwise → local
 */
export function resolveEphemeralHostPolicy(env: NodeJS.ProcessEnv = process.env): HostStartPolicy {
  const force = env.CEDAR_PG_EPHEMERAL_HOST;
  if (force === "1") return "ephemeral";
  if (force === "0") return "local";
  if (env.CI === "true") return "ephemeral";
  return "local";
}

/**
 * Fixed CI recipe: `install --no-pm2 --no-ui --data DIR` + detached
 * `postmaster` (`--ram` + `/dev/shm/cedar-pg-<uid>` on Linux when shm exists).
 */
export function ephemeralHostRecipe(ctx: EphemeralRecipeContext = {}): EphemeralHostRecipe {
  const platform = ctx.platform ?? process.platform;
  const shmAvailable = ctx.shmAvailable ?? (platform === "linux" && existsSync("/dev/shm"));
  const uid = ctx.uid ?? process.getuid?.() ?? 0;
  const useRam = platform === "linux" && shmAvailable;
  const dataDir = useRam
    ? `/dev/shm/cedar-pg-${uid}`
    : join(ctx.tmpDir ?? tmpdir(), "cedar-pg-host");

  const installArgs = ["install", "--no-pm2", "--no-ui", "--data", dataDir];
  const postmasterArgs = useRam
    ? ["postmaster", "--ram", "--socket-dir", dataDir]
    : ["postmaster", "--socket-dir", dataDir, "--data", dataDir];

  return { dataDir, installArgs, postmasterArgs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runInstall(bin: string, args: string[]): void {
  const install = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    throw new Error(
      `Failed to start autopg host (exit ${install.status}).\n` +
        `${install.stderr || install.stdout || ""}\n${INSTALL_HINT}`,
    );
  }
}

/**
 * Install + detached postmaster with fully ignored stdio so the CI job owns lifetime
 * (caller exit must not close pipes under the daemon).
 */
async function startEphemeralHost(bin: string): Promise<AutopgDiscovery> {
  const recipe = ephemeralHostRecipe();
  mkdirSync(recipe.dataDir, { recursive: true });
  runInstall(bin, recipe.installArgs);

  const state: {
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
    spawnError: Error | null;
  } = { exit: null, spawnError: null };

  const child = spawn(bin, recipe.postmasterArgs, {
    detached: true,
    // Fully ignore stdio so unref'd postmaster is not tied to this process's pipes.
    stdio: "ignore",
  });
  child.on("error", (err) => {
    state.spawnError = err;
  });
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
  });

  const deadline = Date.now() + OWNED_POSTMASTER_READY_MS;
  let lastDetail = "host not ready";
  while (Date.now() < deadline) {
    if (state.spawnError) {
      throw new Error(
        `Failed to spawn autopg postmaster.\n${state.spawnError.message}\n${INSTALL_HINT}`,
      );
    }
    if (state.exit) {
      throw new Error(
        `autopg postmaster exited before ready (code=${state.exit.code}, signal=${state.exit.signal}).\n` +
          INSTALL_HINT,
      );
    }
    try {
      const discovery = discoverHost(bin);
      child.unref();
      return discovery;
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      await sleep(OWNED_POSTMASTER_POLL_MS);
    }
  }

  child.unref();
  throw new Error(
    `Timed out waiting for autopg host after ${OWNED_POSTMASTER_READY_MS}ms.\n${lastDetail}\n${INSTALL_HINT}`,
  );
}

/**
 * Ensure the host postmaster is up.
 *
 * - Attaches when `autopg status --json` shows a live host.
 * - Otherwise starts from {@link resolveEphemeralHostPolicy}: local pm2 `install`,
 *   or opinionated ephemeral (`--no-pm2 --no-ui` + detached postmaster).
 * - CI job owns ephemeral postmaster lifetime (no cedar-pg host dispose).
 */
export async function ensureHostRunning(bin = requireAutopgBin()): Promise<AutopgDiscovery> {
  try {
    return discoverHost(bin);
  } catch {
    // status failed — start host per policy
  }

  if (resolveEphemeralHostPolicy() === "ephemeral") {
    return startEphemeralHost(bin);
  }

  runInstall(bin, ["install"]);
  return discoverHost(bin);
}
