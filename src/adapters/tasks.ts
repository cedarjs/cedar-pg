/**
 * Shared CLI command strings for Vite+ / Nx task wiring.
 */

import { CLI_NAME } from "../core/constants.ts";

export type CedarPgCommands = {
  ensureDev: string;
  ensureTest: string;
  disposeTest: string;
};

export function cedarPgCommands(bin = CLI_NAME): CedarPgCommands {
  return {
    ensureDev: `${bin} ensure --mode=dev`,
    ensureTest: `${bin} ensure --mode=test --print-env`,
    disposeTest: `${bin} dispose --mode=test`,
  };
}
