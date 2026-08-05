import { loadModeEnv, normalizeLoadOptions, type LoadModeEnvOptions } from "./load-mode-env.ts";

export type LoadDevEnvOptions = LoadModeEnvOptions;

/** Load `.cedarpg/dev.env` into `process.env`. Use `{ overwrite: true }` to beat `.env`. */
export function loadDevEnv(rootOrOptions?: string | LoadDevEnvOptions): void {
  loadModeEnv("dev", normalizeLoadOptions(rootOrOptions));
}
