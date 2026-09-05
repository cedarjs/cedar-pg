import { spawn } from "node:child_process";

export type RunAttachedOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

/** Attached child: inherit stdio, resolve with exit code (signal → 1). */
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
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}
