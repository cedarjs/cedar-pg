/**
 * Product identity vs frozen crypto.
 *
 * State dirs follow the CLI name (`.cedarpg`): product-owned, not nested under
 * autopg's `~/.autopg/` (host owns that) and not a generic `.pg` (collision-prone).
 * Password salt is an opaque crypto constant; bump ROLE_PASSWORD_SCHEME to change it.
 */

/** User-facing CLI binary (`package.json` bin) and log prefix */
export const CLI_NAME = "cedarpg";

/**
 * Worktree-local state dir and home-registry parent (`~/.cedarpg/registry`).
 * Frozen for lease/gc discovery after first alpha consumers appear.
 */
export const STATE_DIRNAME = ".cedarpg";

/**
 * Password scheme v2 salt prefix: sha256(`${PASSWORD_SALT_PREFIX}\0` + roleName).
 * Opaque; independent of STATE_DIRNAME / CLI_NAME. Bump ROLE_PASSWORD_SCHEME to change.
 */
export const PASSWORD_SALT_PREFIX = "cedar-pg";
