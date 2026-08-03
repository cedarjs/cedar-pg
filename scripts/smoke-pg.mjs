#!/usr/bin/env node
/**
 * Adapter + real Postgres smoke: pack → install tarball in a temp consumer →
 * run Vitest and Jest through @cedarjs/pg adapters.
 *
 * Sets CI=true + CEDAR_PG_EPHEMERAL_HOST=1 so policy prefers ephemeral when no
 * host is live. Attach still wins if autopg status already shows a live host —
 * cold ephemeral start is what empty CI runners exercise.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "scripts/smoke-pg");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PACKAGE_NAME = pkg.name;
const TARBALL_PREFIX = PACKAGE_NAME.replace(/^@/, "").replace("/", "-");

process.env.CEDAR_PG_SKIP_POSTINSTALL ??= "1";

function run(cmd, args, { cwd = ROOT, silent = false, env } = {}) {
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

/** Best-effort: true when `autopg status --json` reports a live host (attach-wins). */
function hostAlreadyLive() {
  const bins = [
    process.env.AUTOPG_BIN,
    "autopg",
    join(process.env.HOME ?? "", ".local/bin/autopg"),
  ].filter(Boolean);
  for (const bin of bins) {
    const result = spawnSync(bin, ["status", "--json"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) continue;
    try {
      const parsed = JSON.parse(result.stdout || "{}");
      if (typeof parsed.port === "number" && parsed.running !== false) {
        return { live: true, port: parsed.port, bin };
      }
    } catch {
      // try next bin
    }
  }
  return { live: false };
}

for (const name of readdirSync(ROOT)) {
  if (name.startsWith(`${TARBALL_PREFIX}-`) && name.endsWith(".tgz")) {
    rmSync(join(ROOT, name), { force: true });
  }
}

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

const tmp = mkdtempSync(join(tmpdir(), `${TARBALL_PREFIX}-smoke-pg-`));
const cleanup = () => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

console.log(`==> scaffold consumer in ${tmp}`);
writeFileSync(
  join(tmp, "package.json"),
  JSON.stringify(
    {
      name: "cedar-pg-smoke-pg",
      private: true,
      type: "module",
    },
    null,
    2,
  ),
);
for (const name of ["vitest.config.mjs", "vitest.test.mjs", "jest.config.cjs", "jest.test.cjs"]) {
  cpSync(join(FIXTURES, name), join(tmp, name));
}

console.log("==> install tarball + runners");
run(
  "npm",
  ["install", tarballPath, "vitest@4.1.9", "jest@29.7.0", "pg@8.16.3", "--legacy-peer-deps"],
  {
    cwd: tmp,
    silent: true,
    env: { ...process.env, CEDAR_PG_SKIP_POSTINSTALL: "1" },
  },
);

const host = hostAlreadyLive();
if (host.live) {
  console.log(
    `==> host already live on port ${host.port} (${host.bin}) — attach-wins; ` +
      "ephemeral cold-start is not exercised here (empty CI runners cover that path)",
  );
} else {
  console.log(
    "==> no live host — policy CI=true + CEDAR_PG_EPHEMERAL_HOST=1 will cold-start ephemeral",
  );
}

const smokeEnv = {
  ...process.env,
  CI: "true",
  CEDAR_PG_EPHEMERAL_HOST: "1",
  CEDAR_PG_INSTALL_AUTOPG: process.env.CEDAR_PG_INSTALL_AUTOPG ?? "1",
};
// Avoid inheriting a developer escape-hatch / disable flag into the fixture.
for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "CEDAR_PG", "CEDAR_PG_FORCE"]) {
  delete smokeEnv[key];
}

console.log("==> vitest via @cedarjs/pg/vitest");
run("npx", ["vitest", "run", "--config", "vitest.config.mjs"], {
  cwd: tmp,
  env: smokeEnv,
});

console.log("==> jest via @cedarjs/pg/jest");
run("npx", ["jest", "--config", "jest.config.cjs", "--runInBand"], {
  cwd: tmp,
  env: smokeEnv,
});

console.log("smoke-pg: PASS");
