#!/usr/bin/env node
/**
 * Ensure the autopg host binary is available after cedar-pg install.
 * Idempotent across npm / yarn / pnpm. Never fails the parent install hard
 * when network is unavailable — prints a clear warning instead.
 *
 * Supply-chain: both the install script ref and the binary release are pinned.
 * Bump AUTOPG_VERSION (and the matching tag in INSTALL_URL) deliberately when
 * upgrading — do not track main/latest.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Pinned autopg release tag. Bump intentionally for upgrades. */
const AUTOPG_VERSION = "v3.0.7";
const INSTALL_URL = `https://raw.githubusercontent.com/automagik-dev/autopg/${AUTOPG_VERSION}/install.sh`;

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

  // Skip in CI unless explicitly requested — CI images often bake autopg
  if (process.env.CI === "true" && process.env.CEDAR_PG_INSTALL_AUTOPG !== "1") {
    console.warn(
      "[cedar-pg] autopg not found; CI detected — skip auto-install. " +
        "Set CEDAR_PG_INSTALL_AUTOPG=1 or install autopg in the image.",
    );
    return;
  }

  console.log(`[cedar-pg] autopg not found — installing ${AUTOPG_VERSION} via pinned install.sh…`);
  const result = spawnSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], {
    stdio: "inherit",
    env: { ...process.env, AUTOPG_VERSION },
  });
  if (result.status !== 0) {
    console.warn(
      "[cedar-pg] automatic autopg install failed.\n" +
        "  Install manually:\n" +
        `  curl -fsSL ${INSTALL_URL} | AUTOPG_VERSION=${AUTOPG_VERSION} bash\n` +
        "  Then ensure ~/.local/bin is on PATH (or set AUTOPG_BIN).",
    );
  }
}

main();
