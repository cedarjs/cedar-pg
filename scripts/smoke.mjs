#!/usr/bin/env node
/**
 * Publish-shape smoke: assumes `vp pack` already ran (via `vp run smoke` → dependsOn build).
 * pnpm pack → install tarball in a temp dir → resolve exports + CLI.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PACKAGE_NAME = pkg.name;
/** npm pack turns `@scope/name` into `scope-name-version.tgz` */
const TARBALL_PREFIX = PACKAGE_NAME.replace(/^@/, "").replace("/", "-");
const CLI_BIN = Object.keys(pkg.bin ?? {})[0] ?? "cedarpg";

process.env.CEDAR_PG_SKIP_POSTINSTALL = "1";

function run(cmd, args, { cwd = ROOT, silent = false, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: silent ? "pipe" : "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    if (silent && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status ?? "null"})`);
  }
  return result;
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

const tmp = mkdtempSync(join(tmpdir(), `${TARBALL_PREFIX}-smoke-`));
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
run("npm", ["init", "-y"], { cwd: tmp, silent: true });
run("npm", ["install", tarballPath, "--legacy-peer-deps"], {
  cwd: tmp,
  silent: true,
  env: { CEDAR_PG_SKIP_POSTINSTALL: "1" },
});

console.log("==> resolve exports");
run(
  "node",
  [
    "--input-type=module",
    "-e",
    `
import { buildDatabaseName } from '${PACKAGE_NAME}';
import { cedarPgTasks } from '${PACKAGE_NAME}/vite-plus';
const name = buildDatabaseName(
  { root: '/tmp/x', repoSlug: 'cedar', worktreeSlug: 'feat', pathHash: 'abcd1234' },
  'dev',
);
if (name !== 'cpg_cedar_feat_dev_abcd1234') throw new Error('bad name ' + name);
const tasks = cedarPgTasks();
if (!tasks['db:ensure']) throw new Error('missing db:ensure');
console.log('ok', name, Object.keys(tasks).join(','));
`,
  ],
  { cwd: tmp },
);

console.log("==> CLI present");
const help = run("node", [join(tmp, "node_modules", PACKAGE_NAME, "dist/cli.mjs"), "--help"], {
  cwd: tmp,
  silent: true,
});
if (!help.stdout?.includes(`${CLI_BIN} ensure`)) {
  throw new Error(`CLI help missing ${CLI_BIN} ensure`);
}

console.log("==> published files exclude smoke harness");
const packed = run("tar", ["-tzf", tarballPath], { silent: true }).stdout ?? "";
if (packed.includes("scripts/smoke.mjs")) {
  throw new Error("smoke.mjs must not be in the published tarball");
}
if (!packed.includes("scripts/postinstall.js")) {
  throw new Error("postinstall.js missing from published tarball");
}

console.log("smoke: PASS");
