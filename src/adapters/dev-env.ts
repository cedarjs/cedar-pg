import { loadDevEnv } from "./load-dev-env.ts";

/**
 * `setupFiles`-style entry: load `.cedarpg/dev.env` with overwrite.
 *
 * ```ts
 * import "@cedarjs/pg/dev-env";
 * ```
 */
loadDevEnv({ overwrite: true });
