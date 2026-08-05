#!/usr/bin/env node
/**
 * Publish-shape smoke: assumes `vp pack` already ran (via `vp run smoke` → dependsOn build).
 * pnpm pack → install tarball in a temp dir → resolve exports + CLI.
 */
import { join } from "node:path";
import {
  CLI_BIN,
  PACKAGE_NAME,
  clearPackedTarballs,
  installConsumer,
  packTarball,
  run,
} from "./smoke-lib.mjs";
process.env.CEDAR_PG_SKIP_POSTINSTALL = "1";

clearPackedTarballs();
const tarballPath = packTarball();
const tmp = installConsumer({
  tarballPath,
  tmpPrefix: `${PACKAGE_NAME.replace(/^@/, "").replace("/", "-")}-smoke-`,
  packageJson: {
    name: "cedar-pg-smoke",
    private: true,
    type: "module",
  },
});

console.log("==> resolve exports");
run(
  "node",
  [
    "--input-type=module",
    "-e",
    `
import {
  buildDatabaseName,
  cloneFromTemplate,
  cloneFromTemplateIfNeeded,
  createAcquireTask,
  envFilePath,
  loadDevEnv,
  loadTestEnv,
  markTemplate,
  STATE_DIRNAME,
} from '${PACKAGE_NAME}';
import { cedarPgTasks } from '${PACKAGE_NAME}/vite-plus';
import { cedarPgNxTargets, cedarPgRunCommand, relativeEnvFile } from '${PACKAGE_NAME}/nx';
import vitestSetup from '${PACKAGE_NAME}/vitest';
import jestSetup from '${PACKAGE_NAME}/jest';
import jestTeardown from '${PACKAGE_NAME}/jest-teardown';
import '${PACKAGE_NAME}/test-env';
import '${PACKAGE_NAME}/dev-env';
import {
  createGlobalSetup as createJestTemplateSetup,
  cloneWorkerDatabase,
} from '${PACKAGE_NAME}/jest/template';
import {
  createGlobalSetup as createVitestTemplateSetup,
  cloneWorkerDatabase as cloneVitestWorkerDatabase,
} from '${PACKAGE_NAME}/vitest/template';
const name = buildDatabaseName(
  { root: '/tmp/x', repoSlug: 'cedar', worktreeSlug: 'feat', pathHash: 'abcd1234' },
  'dev',
);
if (name !== 'cpg_cedar_feat_dev_abcd1234') throw new Error('bad name ' + name);
const tasks = cedarPgTasks();
if (!tasks['db:acquire']) throw new Error('missing db:acquire');
const nxTargets = cedarPgNxTargets();
if (!nxTargets['db:acquire']) throw new Error('missing nx db:acquire');
if (JSON.stringify(tasks) !== JSON.stringify(nxTargets)) {
  throw new Error('vite-plus and nx lifecycle targets drifted');
}
if (!cedarPgRunCommand('dev', 'echo ok').includes('run --mode=dev')) {
  throw new Error('cedarPgRunCommand missing run');
}
if (relativeEnvFile('dev') !== '.cedarpg/dev.env') throw new Error('bad relativeEnvFile');
if (typeof createAcquireTask !== 'function') throw new Error('missing createAcquireTask');
if (typeof vitestSetup !== 'function') throw new Error('vitest setup export missing');
if (typeof jestSetup !== 'function') throw new Error('jest setup export missing');
if (typeof jestTeardown !== 'function') throw new Error('jest-teardown export missing');
if (typeof loadTestEnv !== 'function') throw new Error('loadTestEnv export missing');
if (typeof loadDevEnv !== 'function') throw new Error('loadDevEnv export missing');
if (typeof envFilePath !== 'function') throw new Error('envFilePath export missing');
if (STATE_DIRNAME !== '.cedarpg') throw new Error('bad STATE_DIRNAME ' + STATE_DIRNAME);
if (typeof markTemplate !== 'function') throw new Error('missing markTemplate');
if (typeof cloneFromTemplate !== 'function') throw new Error('missing cloneFromTemplate');
if (typeof cloneFromTemplateIfNeeded !== 'function') throw new Error('missing cloneFromTemplateIfNeeded');
if (typeof createJestTemplateSetup !== 'function') throw new Error('missing jest/template createGlobalSetup');
if (typeof cloneWorkerDatabase !== 'function') throw new Error('missing jest/template cloneWorkerDatabase');
if (typeof createVitestTemplateSetup !== 'function') throw new Error('missing vitest/template createGlobalSetup');
if (typeof cloneVitestWorkerDatabase !== 'function') throw new Error('missing vitest/template cloneWorkerDatabase');
console.log('ok', name, STATE_DIRNAME, Object.keys(tasks).join(','));
`,
  ],
  { cwd: tmp },
);

console.log("==> CLI present");
const help = run("node", [join(tmp, "node_modules", PACKAGE_NAME, "dist/cli.mjs"), "--help"], {
  cwd: tmp,
  silent: true,
});
if (!help.stdout?.includes(`${CLI_BIN} acquire`)) {
  throw new Error(`CLI help missing ${CLI_BIN} acquire`);
}
if (!help.stdout?.includes(`${CLI_BIN} run`)) {
  throw new Error(`CLI help missing ${CLI_BIN} run`);
}

console.log("==> published files exclude smoke harness");
const packed = run("tar", ["-tzf", tarballPath], { silent: true }).stdout ?? "";
if (packed.includes("scripts/smoke.mjs") || packed.includes("scripts/smoke-lib.mjs")) {
  throw new Error("smoke harness must not be in the published tarball");
}
if (!packed.includes("scripts/postinstall.js")) {
  throw new Error("postinstall.js missing from published tarball");
}
if (!packed.includes("scripts/autopg-version")) {
  throw new Error("autopg-version missing from published tarball");
}
if (!packed.includes("scripts/ci-install-autopg.sh")) {
  throw new Error("ci-install-autopg.sh missing from published tarball");
}

console.log("smoke: PASS");
