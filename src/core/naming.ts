import type { WorktreeIdentity } from "./worktree.ts";

export type DbMode = "dev" | "test";

const PG_MAX = 63;
const PREFIX = "cpg_";

/**
 * Build an observable Postgres database name:
 *   cpg_<repoSlug>_<worktreeSlug>_<mode>_<pathHash8>
 *
 * Never drops `mode` or `pathHash`. Truncates slugs to fit ≤63 chars.
 */
export function buildDatabaseName(identity: WorktreeIdentity, mode: DbMode): string {
  const modePart = mode;
  const hashPart = identity.pathHash;
  // PREFIX + slug + '_' + slug + '_' + mode + '_' + hash
  // fixed: PREFIX(4) + 2 underscores around mode/hash segments + mode + hash
  // layout: cpg_<repo>_<wt>_<mode>_<hash>
  const fixed =
    PREFIX.length +
    1 + // after repo
    1 + // after worktree
    modePart.length +
    1 +
    hashPart.length;

  let budget = PG_MAX - fixed;
  if (budget < 2) {
    // Extreme truncation: keep mode+hash, minimal slugs
    return `${PREFIX}${modePart}_${hashPart}`.slice(0, PG_MAX);
  }

  let repo = identity.repoSlug;
  let wt = identity.worktreeSlug;
  // Split budget roughly evenly, preferring to keep both readable
  while (repo.length + wt.length > budget) {
    if (repo.length >= wt.length && repo.length > 1) {
      repo = repo.slice(0, -1);
    } else if (wt.length > 1) {
      wt = wt.slice(0, -1);
    } else {
      break;
    }
  }

  const name = `${PREFIX}${repo}_${wt}_${modePart}_${hashPart}`;
  if (name.length > PG_MAX) {
    return name.slice(0, PG_MAX);
  }
  return name;
}

/**
 * Append `suffix` to a database name, staying ≤63 chars. When it does not fit,
 * cut the readable head (`cpg_<repo>_<worktree>`) and keep the trailing
 * `_<mode>_<pathHash8>` whole: that hash is what keeps worktrees apart.
 */
function appendKeepingHash(databaseName: string, suffix: string): string {
  const full = `${databaseName}${suffix}`;
  if (full.length <= PG_MAX) {
    return full;
  }
  const tail = /_[^_]+_[^_]+$/.exec(databaseName)?.[0] ?? "";
  const head = databaseName
    .slice(0, Math.max(0, PG_MAX - tail.length - suffix.length))
    .replace(/_+$/, "");
  return `${head}${tail}${suffix}`.slice(0, PG_MAX);
}

/** Role for a database name: `<databaseName>_role`, cut by `appendKeepingHash`. */
export function buildRoleName(databaseName: string): string {
  return appendKeepingHash(databaseName, "_role");
}

/**
 * Build a worker clone datname from a TEMPLATE database name.
 * Layout: `<template>_c_<suffix>`, cut by `appendKeepingHash` (keeps mode, hash, and suffix).
 */
export function buildCloneDatabaseName(templateName: string, suffix: string): string {
  const safe = suffix
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  const tag = safe.length > 0 ? safe : "w";
  return appendKeepingHash(templateName, `_c_${tag}`);
}
