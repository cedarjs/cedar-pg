#!/usr/bin/env node
/**
 * Ensure the autopg host binary is available after @cedarjs/pg install.
 * Idempotent across npm / yarn / pnpm. Never fails the parent install hard
 * when network is unavailable; prints a clear warning instead.
 *
 * Version pin: scripts/autopg-version (single source of truth).
 *
 * - Local / non-CI: pinned upstream install.sh (may start pm2).
 * - CI + CEDAR_PG_INSTALL_AUTOPG=1: binary-only scripts/ci-install-autopg.sh
 *   (attestation via gh; no pm2 — cedar-pg ephemeral host owns startup).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOPG_VERSION = readFileSync(join(HERE, "autopg-version"), "utf8").trim();
const INSTALL_URL = `https://raw.githubusercontent.com/automagik-dev/autopg/${AUTOPG_VERSION}/install.sh`;
const CI_INSTALL = join(HERE, "ci-install-autopg.sh");

function hasAutopg() {
  if (process.env.AUTOPG_BIN && existsSync(process.env.AUTOPG_BIN)) return true;
  const which = spawnSync("which", ["autopg"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return true;
  if (existsSync(join(homedir(), ".local", "bin", "autopg"))) return true;
  return false;
}

function main() {
  if (process.env.CEDAR_PG_SKIP_POSTINSTALL === "1") {
    return;
  }
  if (hasAutopg()) {
    return;
  }

  const inCi = process.env.CI === "true";
  const forceCiInstall = process.env.CEDAR_PG_INSTALL_AUTOPG === "1";

  // Skip in CI unless explicitly requested; CI images often bake autopg
  // or run scripts/ci-install-autopg.sh from the workflow.
  if (inCi && !forceCiInstall) {
    console.warn(
      "[cedarpg] autopg not found; CI detected, skip auto-install. " +
        "Set CEDAR_PG_INSTALL_AUTOPG=1 or run scripts/ci-install-autopg.sh.",
    );
    return;
  }

  if (inCi && forceCiInstall) {
    console.log(
      `[cedarpg] autopg not found; CI binary install ${AUTOPG_VERSION} via ci-install-autopg.sh...`,
    );
    const result = spawnSync("bash", [CI_INSTALL], {
      stdio: "inherit",
      env: { ...process.env, AUTOPG_VERSION },
    });
    if (result.status !== 0) {
      console.warn(
        "[cedarpg] CI binary install failed.\n" +
          "  Run: bash scripts/ci-install-autopg.sh\n" +
          "  (requires gh CLI + GH_TOKEN for attestation verify)",
      );
    }
    return;
  }

  console.log(`[cedarpg] autopg not found; installing ${AUTOPG_VERSION} via pinned install.sh...`);
  const result = spawnSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], {
    stdio: "inherit",
    env: { ...process.env, AUTOPG_VERSION },
  });
  if (result.status !== 0) {
    console.warn(
      "[cedarpg] automatic autopg install failed.\n" +
        "  Install manually:\n" +
        `  curl -fsSL ${INSTALL_URL} | AUTOPG_VERSION=${AUTOPG_VERSION} bash\n` +
        "  Then ensure ~/.local/bin is on PATH (or set AUTOPG_BIN).",
    );
  }
}

main();
