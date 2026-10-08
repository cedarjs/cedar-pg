import { spawn } from "node:child_process";
import { constants } from "node:os";

export type RunAttachedOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Attached child: inherit stdio, forward SIGINT / SIGTERM / SIGHUP to the
 * child while it runs, resolve with its exit code (killed by signal → 128 + n).
 */
export function runAttached(
  command: string,
  args: string[],
  options: RunAttachedOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const detach = () => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    };
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      detach();
      resolve(signal ? 128 + constants.signals[signal] : (code ?? 1));
    });
  });
}
