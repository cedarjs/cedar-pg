#!/usr/bin/env node
/**
 * Adapter + real Postgres smoke: pack → install tarball in a temp consumer →
 * run Vitest and Jest through @cedarjs/pg adapters.
 *
 * Sets CI=true + CEDAR_PG_EPHEMERAL_HOST=1 so policy prefers ephemeral when no
 * host is live. Attach still wins if a host is already live — cold ephemeral
 * start is what empty CI runners exercise (workflow runs ci-install-autopg.sh).
 */
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

for (const name of ["vitest.config.mjs", "vitest.test.mjs", "jest.config.cjs", "jest.test.cjs"]) {
  cpSync(join(FIXTURES, name), join(tmp, name));
}

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

console.log("smoke-pg: PASS");
