import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function runProcess(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        reject(new Error(`process timed out after ${options.timeoutMs}ms: ${command}`));
      } else {
        resolve(result);
      }
    });
  });
}

export async function runChecked(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed code=${result.code} signal=${result.signal}: ${trimOutput(result.stderr || result.stdout)}`);
  }
  return result;
}

export function runShell(script: string, options: ProcessRunOptions): Promise<ProcessResult> {
  return runProcess("bash", ["-lc", script], options);
}

function trimOutput(output: string): string {
  return output.trim().slice(0, 1000);
}
