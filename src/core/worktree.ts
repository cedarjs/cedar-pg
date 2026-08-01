import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export type WorktreeIdentity = {
  /** Absolute path to the worktree / project root. */
  root: string;
  /** Basename of the git common dir / main checkout (e.g. `cedar`). */
  repoSlug: string;
  /** Basename of this worktree directory (e.g. `feat-auth`). */
  worktreeSlug: string;
  /** First 8 hex chars of sha256(absolute root). */
  pathHash: string;
};

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Resolve the project / worktree root.
 * Explicit `root` wins (app project path). Otherwise prefer git toplevel, then cwd.
 */
export function resolveRoot(root?: string): string {
  if (root) return resolve(root);
  const start = resolve(process.cwd());
  const toplevel = git(["rev-parse", "--show-toplevel"], start);
  if (toplevel) return toplevel;
  return start;
}

/**
 * Identify repo + worktree for observable DB naming.
 */
export function resolveWorktreeIdentity(root?: string): WorktreeIdentity {
  const absRoot = resolveRoot(root);
  const pathHash = createHash("sha256").update(absRoot).digest("hex").slice(0, 8);

  const commonDir = git(["rev-parse", "--git-common-dir"], absRoot);
  let repoSlug = sanitizeSlug(basename(absRoot));
  if (commonDir) {
    // common-dir is often `<main>/.git` or an absolute path to the main .git
    const commonAbs = resolve(absRoot, commonDir);
    // If commonAbs ends with `.git`, parent is main worktree root
    const mainRoot = basename(commonAbs) === ".git" ? dirname(commonAbs) : commonAbs;
    // For linked worktrees, common-dir may be `.../main/.git`
    const candidate = basename(mainRoot) === ".git" ? dirname(mainRoot) : mainRoot;
    const fromGit = sanitizeSlug(basename(candidate));
    if (fromGit) repoSlug = fromGit;
  }

  // Prefer gitdir worktree name when present (`.git` file pointing at worktrees/<name>)
  let worktreeSlug = sanitizeSlug(basename(absRoot));
  const gitFile = resolve(absRoot, ".git");
  if (existsSync(gitFile)) {
    try {
      const content = readFileSync(gitFile, "utf8").trim();
      const match = content.match(/gitdir:\s*(.+)$/m);
      if (match?.[1]) {
        const gitdir = resolve(absRoot, match[1].trim());
        // .../.git/worktrees/<name>
        const parts = gitdir.split(/[/\\]/);
        const wtIdx = parts.lastIndexOf("worktrees");
        if (wtIdx >= 0 && parts[wtIdx + 1]) {
          const fromWt = sanitizeSlug(parts[wtIdx + 1]!);
          if (fromWt) worktreeSlug = fromWt;
        }
      }
    } catch {
      // keep basename slug
    }
  }

  if (!repoSlug) repoSlug = "repo";
  if (!worktreeSlug) worktreeSlug = "wt";

  return { root: absRoot, repoSlug, worktreeSlug, pathHash };
}

export function fingerprintFor(root: string, mode: string): string {
  return createHash("sha256").update(`${root}\0${mode}`).digest("hex");
}
