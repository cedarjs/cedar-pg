/**
 * Shared CLI command strings for Vite+ / Nx task wiring.
 */

export type CedarPgCommands = {
  ensureDev: string;
  ensureTest: string;
  disposeTest: string;
};

export function cedarPgCommands(bin = "cedar-pg"): CedarPgCommands {
  return {
    ensureDev: `${bin} ensure --mode=dev`,
    ensureTest: `${bin} ensure --mode=test --print-env`,
    disposeTest: `${bin} dispose --mode=test`,
  };
}
