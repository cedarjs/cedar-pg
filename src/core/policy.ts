/**
 * Shared ensure skip policy for test-runner adapters and Cedar CLI bridges.
 */

export type EnsureSkip =
  | { skip: false }
  | { skip: true; reason: "disabled" }
  | { skip: true; reason: "external-url"; databaseUrl: string };

export type ResolveEnsureSkipInput = {
  /** Candidate URL (TEST_DATABASE_URL for tests, DATABASE_URL for dev). */
  url?: string;
  /** When true, never skip (CEDAR_PG_FORCE=1). */
  force?: boolean;
  /**
   * When true, skip ensure entirely.
   * Defaults from CEDAR_PG=0|false (opt-out adapters). Pass `false` for Cedar opt-in flows.
   */
  disabled?: boolean;
};

/**
 * True when the URL looks like a cedarpg provisioned database (`cpg_*` name/role).
 * These must never be treated as an external escape hatch; always re-ensure so
 * disposed/stale shell env cannot skip provisioning.
 */
export function isCedarPgManagedUrl(url: string | undefined): boolean {
  if (!url || url.startsWith("file:")) return false;
  try {
    const parsed = new URL(url);
    const databaseName = decodeURIComponent(
      (parsed.pathname.replace(/^\//, "").split("?")[0] ?? "").trim(),
    );
    const user = decodeURIComponent(parsed.username);
    return databaseName.startsWith("cpg_") || user.startsWith("cpg_");
  } catch {
    return false;
  }
}

/**
 * True when `url` still looks like an unset dotenv/template value
 * (e.g. `postgresql://{yourMachine}@localhost:5432/app_test` or
 * `postgresql://<user>@localhost/db`), not a real external database.
 */
function isUnsetTemplateUrl(url: string): boolean {
  // `{yourMachine}`, `{user}`, etc.
  if (/\{[^}]+\}/.test(url)) return true;
  // `<user>`, `<password>` style templates
  if (/<[^>]+>/.test(url)) return true;
  return false;
}

/**
 * True when `url` is a real external database and ensure should be skipped.
 * Sqlite `file:` URLs, cedarpg `cpg_*` URLs, and unset template placeholders
 * are not external.
 */
export function isExternalDatabaseEscapeHatch(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("file:")) return false;
  if (isCedarPgManagedUrl(url)) return false;
  if (isUnsetTemplateUrl(url)) return false;
  return true;
}

/**
 * Decide whether ensure should run.
 * Adapters may call with no args (env defaults). Cedar opt-in should pass `disabled: false`
 * and the relevant `url` (`DATABASE_URL` or `TEST_DATABASE_URL`).
 */
export function resolveEnsureSkip(input: ResolveEnsureSkipInput = {}): EnsureSkip {
  const disabled =
    input.disabled ?? (process.env.CEDAR_PG === "0" || process.env.CEDAR_PG === "false");
  if (disabled) {
    return { skip: true, reason: "disabled" };
  }

  const force = input.force ?? process.env.CEDAR_PG_FORCE === "1";
  if (force) {
    return { skip: false };
  }

  const url = input.url !== undefined ? input.url : process.env.TEST_DATABASE_URL;
  if (url && isExternalDatabaseEscapeHatch(url)) {
    return { skip: true, reason: "external-url", databaseUrl: url };
  }
  return { skip: false };
}
