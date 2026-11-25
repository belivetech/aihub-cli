import { spawn } from "node:child_process";
import os from "node:os";

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

export interface SpawnHarnessOptions {
  binPath: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export function spawnHarness(opts: SpawnHarnessOptions): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(opts.binPath, [...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "inherit",
    });

    const onSigInt = () => {
      // Child shares foreground TTY and receives SIGINT directly
    };
    const onSigTerm = () => {
      child.kill("SIGTERM");
    };
    const onSigHup = () => {
      child.kill("SIGHUP");
    };

    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    process.on("SIGHUP", onSigHup);

    const cleanup = () => {
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGHUP", onSigHup);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("exit", (code, signal) => {
      cleanup();
      if (signal) {
        const num = os.constants.signals[signal] ?? SIGNAL_NUMBERS[signal] ?? 1;
        resolve(128 + num);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
