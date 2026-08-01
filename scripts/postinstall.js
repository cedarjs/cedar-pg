#!/usr/bin/env node
/**
 * Ensure the autopg host binary is available after cedar-pg install.
 * Idempotent across npm / yarn / pnpm. Never fails the parent install hard
 * when network is unavailable — prints a clear warning instead.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INSTALL_URL = "https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh";

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

  console.log("[cedar-pg] autopg not found — installing via official install.sh…");
  const result = spawnSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.warn(
      "[cedar-pg] automatic autopg install failed.\n" +
        "  Install manually:\n" +
        `  curl -fsSL ${INSTALL_URL} | bash\n` +
        "  Then ensure ~/.local/bin is on PATH (or set AUTOPG_BIN).",
    );
  }
}

main();
