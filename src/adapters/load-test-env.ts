import { loadModeEnv, normalizeLoadOptions, type LoadModeEnvOptions } from "./load-mode-env.ts";

export type LoadTestEnvOptions = LoadModeEnvOptions;

/**
 * Load `.cedarpg/test.env` into `process.env` (worker-side).
 *
 * Jest (and optional Vitest `setupFiles`) run tests in a different process than
 * `globalSetup`, so `setEnv` in acquire does not reach workers — the env file does.
 *
 * No-ops unless a matching `test.json` lease exists, so a leftover env after dispose
 * cannot inject a dropped DATABASE_URL.
 */
export function loadTestEnv(rootOrOptions?: string | LoadTestEnvOptions): void {
  loadModeEnv("test", normalizeLoadOptions(rootOrOptions));
}
