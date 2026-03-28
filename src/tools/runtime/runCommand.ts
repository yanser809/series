import { spawn } from "node:child_process";
import * as os from "node:os";

export type RunCommandOptions = {
  /** Working directory for the child process (default: process.cwd()) */
  cwd?: string;
  /** Extra environment variables merged with process.env */
  env?: NodeJS.ProcessEnv;
  /** Hard kill timeout in milliseconds (default: 120 000 ms) */
  timeoutMs?: number;
  /** Maximum combined stdout + stderr bytes before truncation (default: 512 000) */
  maxOutputBytes?: number;
};

export type RunCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Output was truncated because it exceeded maxOutputBytes */
  truncated: boolean;
  /** Process wall-clock duration in ms */
  durationMs: number;
  /** Process was killed because it exceeded timeoutMs */
  timedOut: boolean;
};

/**
 * Run a command using child_process.spawn.
 *
 * Features:
 *  - Hard SIGKILL timeout (kills the entire process group on Linux)
 *  - Output size limit: kills and truncates when maxOutputBytes is exceeded
 *  - Structured result (never throws for non-zero exit codes)
 */
export async function runCommand(
  command: string,
  args: string[] = [],
  opts: RunCommandOptions = {}
): Promise<RunCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 512_000;
  const isLinux = os.platform() !== "win32";

  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      // detached so we can kill the whole process group on Linux
      detached: isLinux,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;

    const killGroup = () => {
      try {
        if (isLinux && child.pid !== undefined) {
          // Negative PID kills the entire process group
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Process may already be gone; ignore
      }
    };

    const onData = (which: "stdout" | "stderr", chunk: Buffer) => {
      if (truncated) return;

      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        truncated = true;
        killGroup();
        return;
      }

      if (which === "stdout") {
        stdoutChunks.push(chunk);
      } else {
        stderrChunks.push(chunk);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      console.log(
        `[runCommand] cmd=${command} args=${JSON.stringify(args)} ` +
          `exit=${code ?? signal} duration=${Date.now() - start}ms ` +
          `timedOut=${timedOut} truncated=${truncated}`
      );

      resolve({
        code,
        signal,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
