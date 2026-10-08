import { buildCloneDatabaseName, type DbMode } from "./naming.ts";
import type { Lease } from "./lease.ts";
import { attach } from "./lifecycle.ts";
import { applyDatabaseUrlEnv, runIfNeeded, type ResolveAcquireSkipInput } from "./policy.ts";
import {
  adminUrlFor,
  buildDatabaseUrl,
  cloneDatabaseFromTemplate,
  dropDatabase,
  setDatabaseIsTemplate,
} from "../providers/autopg.ts";

/**
 * Lease + admin URL the way `attach` connects: lease file, one TCP probe on the
 * leased port, never host discovery / start / revive. Workers call this once per
 * test file, so it must stay cheap (no git, no `autopg` processes).
 */
async function attachAdmin(options: {
  root?: string;
  mode: DbMode;
  adminUrl?: string;
}): Promise<{ lease: Lease; adminUrl: string }> {
  const { lease } = await attach(options);
  return { lease, adminUrl: options.adminUrl ?? adminUrlFor(lease.port) };
}

export type MarkTemplateOptions = {
  root?: string;
  mode: DbMode;
  /** Superuser URL from `acquire`; when omitted, built from the lease port (never starts the host). */
  adminUrl?: string;
};

/**
 * After migrations, mark the leased DB as a PostgreSQL TEMPLATE so workers can clone it.
 * Requires a lease from `acquire` (no datname override).
 */
export async function markTemplate(
  options: MarkTemplateOptions,
): Promise<{ databaseName: string; adminUrl: string }> {
  const { lease, adminUrl } = await attachAdmin(options);
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
  /** Superuser URL from `acquire`; when omitted, built from the lease port (never starts the host). */
  adminUrl?: string;
  /**
   * Suffix for the clone datname (e.g. Jest worker id).
   * Defaults to `<pid>_<base36 time>`.
   */
  name?: string;
  /**
   * Keep an existing `<template>_c_<name>` owned by the lease role instead of
   * failing with `database already exists` (default false). Worker adapters pass
   * true so every test file in one worker attaches to the same clone.
   */
  reuse?: boolean;
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
 * Port comes from the lease; admin URL is passed through or built from the lease
 * port. Fails when nothing listens there (setup should have acquired).
 * An existing clone datname fails unless `reuse` is set and the lease role owns it.
 */
export async function cloneFromTemplate(options: CloneFromTemplateOptions): Promise<CloneResult> {
  const { lease, adminUrl } = await attachAdmin(options);
  const suffix = options.name ?? `${process.pid}_${Date.now().toString(36)}`;
  const databaseName = buildCloneDatabaseName(lease.databaseName, suffix);

  await cloneDatabaseFromTemplate({
    adminUrl,
    templateName: lease.databaseName,
    databaseName,
    roleName: lease.roleName,
    reuse: options.reuse,
  });

  const databaseUrl = buildDatabaseUrl({
    port: lease.port,
    databaseName,
    roleName: lease.roleName,
  });

  if (options.setEnv) {
    applyDatabaseUrlEnv(databaseUrl, { mode: options.mode });
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

export type CloneFromTemplateIfNeededOptions = CloneFromTemplateOptions & ResolveAcquireSkipInput;

export type CloneFromTemplateIfNeededResult =
  | { status: "skipped"; reason: "disabled" }
  | { status: "skipped"; reason: "external-url"; databaseUrl: string }
  | ({ status: "cloned" } & CloneResult);

/**
 * Resolve skip policy then clone. Host entry for worker adapters (same skip
 * semantics as `acquireIfNeeded`). Defaults `setEnv` on for skip and clone paths.
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
