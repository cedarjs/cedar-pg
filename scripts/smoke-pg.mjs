#!/usr/bin/env node
/**
 * Adapter + real Postgres smoke: pack → install tarball in a temp consumer →
 * run Vitest, Jest (stock + multi-file TEMPLATE), and the CLI through @cedarjs/pg.
 *
 * Sets CI=true + CEDAR_PG_EPHEMERAL_HOST=1 so policy starts an owned ephemeral
 * postmaster when nothing is listening — what empty CI runners exercise (the
 * workflow installs the binary only, via ci-install-autopg.sh). Attach still
 * wins if a host is already live.
 */
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import {
  PACKAGE_NAME,
  ROOT,
  clearPackedTarballs,
  ensureAutopgBinary,
  installConsumer,
  packTarball,
  run,
} from "./smoke-lib.mjs";

process.env.CEDAR_PG_SKIP_POSTINSTALL ??= "1";

const FIXTURES = join(ROOT, "scripts/smoke-pg");

clearPackedTarballs();
const tarballPath = packTarball();
const tmp = installConsumer({
  tarballPath,
  tmpPrefix: `${PACKAGE_NAME.replace(/^@/, "").replace("/", "-")}-smoke-pg-`,
  packageJson: {
    name: "cedar-pg-smoke-pg",
    private: true,
    type: "module",
  },
  npmPackages: ["vitest@4.1.9", "jest@29.7.0", "pg@8.16.3"],
});

cpSync(FIXTURES, tmp, { recursive: true });
// Second TEMPLATE test file for the same worker: proves clone reuse across files
// and the default TRUNCATE … RESTART IDENTITY reset between them.
cpSync(join(tmp, "jest-template.test.cjs"), join(tmp, "jest-template-2.test.cjs"));

// Binary-only install when missing — never postinstall / install.sh / pm2.
const pathEnv = ensureAutopgBinary(process.env);

const smokeEnv = {
  ...pathEnv,
  CI: "true",
  CEDAR_PG_EPHEMERAL_HOST: "1",
};
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

console.log(
  "==> jest TEMPLATE: crashed-run leftovers, then two files reuse + reset one worker clone",
);
run("node", ["seed-crashed-template.mjs"], { cwd: tmp, env: smokeEnv });
run("npx", ["jest", "--config", "jest-template.config.cjs", "--runInBand"], {
  cwd: tmp,
  env: smokeEnv,
});

console.log("==> cedarpg acquire / run / run --attach / dispose");
run("git", ["init"], { cwd: tmp, env: smokeEnv, silent: true });
const cli = join(tmp, "node_modules", PACKAGE_NAME, "dist/cli.mjs");
const childChecksUrls = [
  "node",
  "-e",
  "const u = process.env.DATABASE_URL; " +
    "if (!u.includes('/cpg_') || process.env.TEST_DATABASE_URL !== u) process.exit(1)",
];
run("node", [cli, "acquire", "--mode=test", "--json"], { cwd: tmp, env: smokeEnv });
run("node", [cli, "run", "--mode=test", "--", ...childChecksUrls], { cwd: tmp, env: smokeEnv });
run("node", [cli, "run", "--attach", "--mode=test", "--", ...childChecksUrls], {
  cwd: tmp,
  env: smokeEnv,
});
run("node", [cli, "dispose", "--mode=test"], { cwd: tmp, env: smokeEnv });

// No lease → attach must fail instead of acquiring.
const orphanAttach = spawnSync(
  "node",
  [cli, "run", "--attach", "--mode=test", "--", "node", "-e", ""],
  { cwd: tmp, env: smokeEnv, encoding: "utf8" },
);
if (orphanAttach.status === 0 || !/no test lease/.test(orphanAttach.stderr)) {
  process.stderr.write(orphanAttach.stderr ?? "");
  throw new Error("cedarpg run --attach without a lease must fail with 'no test lease'");
}

console.log("smoke-pg: PASS");
