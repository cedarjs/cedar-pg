import { buildCloneDatabaseName, type DbMode } from "./naming.ts";
import { readLease } from "./lease.ts";
import { applyDatabaseUrlEnv, runIfNeeded, type ResolveEnsureSkipInput } from "./policy.ts";
import { resolveWorktreeIdentity } from "./worktree.ts";
import {
  buildDatabaseUrl,
  cloneDatabaseFromTemplate,
  dropDatabase,
  setDatabaseIsTemplate,
} from "../providers/autopg.ts";
import { ensureHostRunning } from "../providers/host.ts";

async function resolveAdminUrl(adminUrl?: string): Promise<string> {
  return adminUrl ?? (await ensureHostRunning()).adminUrl;
}

export type MarkTemplateOptions = {
  root?: string;
  mode: DbMode;
  /** Superuser URL from `ensure`; when omitted, discovers/starts the host. */
  adminUrl?: string;
};

/**
 * After migrations, mark the leased DB as a PostgreSQL TEMPLATE so workers can clone it.
 * Requires a lease from `ensure` (no datname override).
 */
export async function markTemplate(
  options: MarkTemplateOptions,
): Promise<{ databaseName: string; adminUrl: string }> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const lease = readLease(identity.root, mode);
  if (!lease) {
    throw new Error(`no ${mode} lease; run ensure before markTemplate`);
  }
  const adminUrl = await resolveAdminUrl(options.adminUrl);
  await setDatabaseIsTemplate({
    adminUrl,
    databaseName: lease.databaseName,
    isTemplate: true,
  });
  return { databaseName: lease.databaseName, adminUrl };
}

export type CloneFromTemplateOptions = {
  root?: string;
  mode: DbMode;
  /** Superuser URL from `ensure`; when omitted, discovers/starts the host. */
  adminUrl?: string;
  /**
   * Suffix for the clone datname (e.g. Jest worker id).
   * Defaults to `<pid>_<base36 time>`.
   */
  name?: string;
  /**
   * Inject DATABASE_URL / TEST_DATABASE_URL for this clone (default false).
   * Host `cloneFromTemplateIfNeeded` defaults true; worker adapters pass true explicitly.
   */
  setEnv?: boolean;
};

export type CloneResult = {
  databaseUrl: string;
  adminUrl: string;
  databaseName: string;
  roleName: string;
  templateName: string;
  port: number;
  /**
   * DROP this clone only (leaves TEMPLATE + role if still owned elsewhere).
   * Not suite teardown — use role-scoped `dispose` for that.
   */
  dropClone: () => Promise<void>;
};

/**
 * Clone the leased TEMPLATE database via admin (`CREATE DATABASE … TEMPLATE`).
 * Reuses the template role so `databaseUrl` passwords stay valid (scheme v2).
 * Provider rejects when the leased DB is not marked TEMPLATE.
 * Port comes from the lease; admin URL is passed through or rediscovered.
 */
export async function cloneFromTemplate(options: CloneFromTemplateOptions): Promise<CloneResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const lease = readLease(identity.root, mode);
  if (!lease) {
    throw new Error(`no ${mode} lease; run ensure + markTemplate before cloneFromTemplate`);
  }

  const adminUrl = await resolveAdminUrl(options.adminUrl);
  const suffix = options.name ?? `${process.pid}_${Date.now().toString(36)}`;
  const databaseName = buildCloneDatabaseName(lease.databaseName, suffix);

  await cloneDatabaseFromTemplate({
    adminUrl,
    templateName: lease.databaseName,
    databaseName,
    roleName: lease.roleName,
  });

  const databaseUrl = buildDatabaseUrl({
    port: lease.port,
    databaseName,
    roleName: lease.roleName,
  });

  if (options.setEnv) {
    applyDatabaseUrlEnv(databaseUrl, { mode });
  }

  const roleName = lease.roleName;

  return {
    databaseUrl,
    adminUrl,
    databaseName,
    roleName,
    templateName: lease.databaseName,
    port: lease.port,
    dropClone: async () => {
      await dropDatabase({ adminUrl, databaseName, roleName });
    },
  };
}

export type CloneFromTemplateIfNeededOptions = CloneFromTemplateOptions & ResolveEnsureSkipInput;

export type CloneFromTemplateIfNeededResult =
  | { status: "skipped"; reason: "disabled" }
  | { status: "skipped"; reason: "external-url"; databaseUrl: string }
  | ({ status: "cloned" } & CloneResult);

/**
 * Resolve skip policy then clone. Host entry for worker adapters (same skip
 * semantics as `ensureIfNeeded`). Defaults `setEnv` on for skip and clone paths.
 */
export async function cloneFromTemplateIfNeeded(
  options: CloneFromTemplateIfNeededOptions,
): Promise<CloneFromTemplateIfNeededResult> {
  const outcome = await runIfNeeded(options, () =>
    cloneFromTemplate({
      ...options,
      setEnv: options.setEnv !== false,
    }),
  );
  if (outcome.status === "skipped") return outcome;
  return { status: "cloned", ...outcome.value };
}
