#!/usr/bin/env bash
# Simulate a published install: vp pack → npm pack → install tarball in a temp dir.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export CEDAR_PG_SKIP_POSTINSTALL=1

echo "==> vp pack"
vp pack

echo "==> pnpm pack"
rm -f "$ROOT"/cedar-pg-*.tgz
pnpm pack --pack-destination "$ROOT" >/dev/null
TARBALL="$(ls -1 "$ROOT"/cedar-pg-*.tgz | head -1)"
if [[ ! -f "$TARBALL" ]]; then
  echo "pnpm pack failed to produce a tarball" >&2
  exit 1
fi
echo "    packed $TARBALL"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP" "$TARBALL"; }
trap cleanup EXIT

echo "==> install tarball into $TMP"
cd "$TMP"
npm init -y >/dev/null
CEDAR_PG_SKIP_POSTINSTALL=1 npm install "$TARBALL" --legacy-peer-deps >/dev/null

echo "==> resolve exports"
node --input-type=module -e "
import { buildDatabaseName } from 'cedar-pg';
import { cedarPgTasks } from 'cedar-pg/vite-plus';
const name = buildDatabaseName(
  { root: '/tmp/x', repoSlug: 'cedar', worktreeSlug: 'feat', pathHash: 'abcd1234' },
  'dev',
);
if (name !== 'cpg_cedar_feat_dev_abcd1234') throw new Error('bad name ' + name);
const tasks = cedarPgTasks();
if (!tasks['db:ensure']) throw new Error('missing db:ensure');
console.log('ok', name, Object.keys(tasks).join(','));
"

echo "==> CLI present"
node "$TMP/node_modules/cedar-pg/dist/cli.mjs" --help | grep -q "cedar-pg ensure"

echo "smoke-local: PASS"
