import { spawn } from "node:child_process";
import readline from "node:readline";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  allowFailure?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

export class CommandTimeoutError extends Error {
  readonly code = "COMMAND_TIMEOUT";

  constructor(command: string, timeoutMs: number) {
    super(`${command} hat das Zeitlimit von ${Math.ceil(timeoutMs / 1_000)} Sekunden überschritten`);
    this.name = "CommandTimeoutError";
  }
}

export class CommandCancelledError extends Error {
  readonly code = "COMMAND_CANCELLED";

  constructor(command: string) {
    super(`${command} wurde abgebrochen`);
    this.name = "CommandCancelledError";
  }
}

export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CommandCancelledError(command));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const maxOutputChars = options.maxOutputChars ?? 1_000_000;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between the timeout and signal delivery.
      }
    };
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          if (aborted || timedOut) return;
          timedOut = true;
          terminate("SIGTERM");
          forceKillTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
          forceKillTimer.unref();
        }, timeoutMs)
      : undefined;
    timeout?.unref();
    const abortHandler = (): void => {
      if (aborted || timedOut) return;
      aborted = true;
      terminate("SIGTERM");
      forceKillTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
      forceKillTimer.unref();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };
    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });
    stdoutReader.on("line", (line) => {
      stdout = `${stdout}${line}\n`.slice(-(maxOutputChars + 1));
      options.onStdout?.(line);
    });
    stderrReader.on("line", (line) => {
      stderr = `${stderr}${line}\n`.slice(-(maxOutputChars + 1));
      options.onStderr?.(line);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      const exitCode = code ?? 1;
      const result = { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode };
      if (timedOut) {
        reject(new CommandTimeoutError(command, timeoutMs));
      } else if (aborted) {
        reject(new CommandCancelledError(command));
      } else if (exitCode !== 0 && !options.allowFailure) {
        const detail = result.stderr.split("\n").at(-1) || result.stdout.split("\n").at(-1) || signal || `exit ${exitCode}`;
        reject(new Error(`${command} fehlgeschlagen: ${detail}`));
      } else {
        resolve(result);
      }
    });
  });
}
