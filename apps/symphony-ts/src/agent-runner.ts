import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexAppServerClient } from "./codex-app-server.ts";
import type { AgentEvent, EffectiveConfig, Issue, Logger, RunAttempt } from "./types.ts";
import { GitWorkspaceManager } from "./git-workspace.ts";
import { HandoffManager, failureComment, successComment } from "./handoff.ts";
import { LinearWriteback } from "./linear-writeback.ts";
import { renderPrompt } from "./prompt.ts";
import { errorMessage, isPathInside } from "./util.ts";
import { WorkspaceManager } from "./workspace.ts";

type RunMode = "planning" | "implementation";
type AgentResult = { status: "Succeeded" | "Failed" | "TimedOut"; error: string | null; output: string | null };

export interface AgentRunnerOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  isStillActive?: () => Promise<boolean>;
}

export class AgentRunner {
  private readonly config: EffectiveConfig;
  private readonly logger: Logger;

  constructor(
    config: EffectiveConfig,
    logger: Logger,
  ) {
    this.config = config;
    this.logger = logger;
  }

  async run(issue: Issue, attempt: number | null, options: AgentRunnerOptions = {}): Promise<RunAttempt> {
    const startedAt = Date.now();
    let workspacePath = "";
    const workspaceManager = new WorkspaceManager(this.config, this.logger);

    try {
      const workspace = await workspaceManager.ensureWorkspace(issue.identifier);
      workspacePath = workspace.path;
      const gitWorkspace = await new GitWorkspaceManager(this.config, this.logger).prepare(workspacePath, issue);
      validateLaunchCwd(workspacePath, gitWorkspace.runPath);
      const mode = runMode(this.config, issue);
      if (mode === "implementation") {
        await new LinearWriteback(this.config, this.logger).markRunning(issue);
      }
      await workspaceManager.beforeRun(gitWorkspace.runPath);
      options.onEvent?.({ event: "workspace_ready", timestamp: new Date().toISOString(), workspace_path: gitWorkspace.runPath });
      const prompt = renderPrompt(this.configPromptTemplate(), issueForMode(issue, mode), attempt);
      await fs.mkdir(path.join(workspacePath, ".symphony"), { recursive: true });
      await fs.writeFile(path.join(workspacePath, ".symphony", "prompt.md"), prompt, "utf8");
      if (gitWorkspace.runPath !== workspacePath) {
        await fs.mkdir(path.join(gitWorkspace.runPath, ".symphony"), { recursive: true });
        await fs.writeFile(path.join(gitWorkspace.runPath, ".symphony", "prompt.md"), prompt, "utf8");
      }
      const result = this.config.codex.protocol === "app_server"
        ? await new CodexAppServerClient(this.config, this.logger).run(issue, gitWorkspace.runPath, prompt, options)
        : await this.launchCommand(issue, gitWorkspace.runPath, prompt, options);
      if (result.status === "Succeeded" && mode === "planning") {
        await new LinearWriteback(this.config, this.logger).markPlan(issue, planComment(issue, result.output));
      } else if (result.status === "Succeeded") {
        const handoff = await new HandoffManager(this.config, this.logger).complete(issue, gitWorkspace);
        await new LinearWriteback(this.config, this.logger).markReview(issue, successComment(issue, handoff));
      } else {
        await new LinearWriteback(this.config, this.logger).markFailed(issue, failureComment(issue, result.error ?? result.status));
      }
      await workspaceManager.afterRun(gitWorkspace.runPath);
      return {
        issue,
        attempt,
        status: result.status,
        workspacePath: gitWorkspace.runPath,
        startedAt,
        endedAt: Date.now(),
        error: result.error,
      };
    } catch (error) {
      if (workspacePath) {
        await workspaceManager.afterRun(workspacePath);
      }
      await new LinearWriteback(this.config, this.logger).markFailed(issue, failureComment(issue, errorMessage(error)));
      return {
        issue,
        attempt,
        status: "Failed",
        workspacePath,
        startedAt,
        endedAt: Date.now(),
        error: errorMessage(error),
      };
    }
  }

  private configPromptTemplate(): string {
    return (this.config as EffectiveConfig & { promptTemplate?: string }).promptTemplate ?? "";
  }

  private async launchCommand(
    issue: Issue,
    cwd: string,
    prompt: string,
    options: AgentRunnerOptions,
  ): Promise<AgentResult> {
    await fs.mkdir(path.join(cwd, ".symphony", "logs"), { recursive: true });
    const logPath = path.join(cwd, ".symphony", "logs", `${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    const logFile = await fs.open(logPath, "a");
    let timedOut = false;

    this.logger.info("agent command launching", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      cwd,
      command: this.config.codex.command,
    });

    return new Promise((resolve) => {
      const child = spawn("bash", ["-lc", this.config.codex.command], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const logChunks: Buffer[] = [];
      const sessionId = `process-${child.pid ?? "unknown"}-${Date.now()}`;
      options.onEvent?.({
        event: "session_started",
        timestamp: new Date().toISOString(),
        codex_app_server_pid: child.pid ? String(child.pid) : null,
        session_id: sessionId,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.config.codex.turnTimeoutMs);

      const abort = () => {
        child.kill("SIGTERM");
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdin.end(prompt);
      child.stdout.on("data", (chunk) => {
        logChunks.push(Buffer.from(chunk));
        options.onEvent?.({
          event: "other_message",
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          message: chunk.toString("utf8").slice(0, 500),
        });
      });
      child.stderr.on("data", (chunk) => {
        logChunks.push(Buffer.from(chunk));
      });
      child.on("error", async (error) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (logChunks.length > 0) {
          await logFile.appendFile(Buffer.concat(logChunks));
        }
        await logFile.close();
        resolve({ status: "Failed", error: error.message, output: null });
      });
      child.on("close", async (code, signal) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (logChunks.length > 0) {
          await logFile.appendFile(Buffer.concat(logChunks));
        }
        await logFile.close();
        const output = logChunks.length > 0 ? Buffer.concat(logChunks).toString("utf8").trim().slice(0, 4000) || null : null;
        if (timedOut) {
          options.onEvent?.({ event: "turn_failed", timestamp: new Date().toISOString(), session_id: sessionId });
          resolve({ status: "TimedOut", error: `turn timed out after ${this.config.codex.turnTimeoutMs}ms`, output });
        } else if (code === 0) {
          options.onEvent?.({ event: "turn_completed", timestamp: new Date().toISOString(), session_id: sessionId });
          resolve({ status: "Succeeded", error: null, output });
        } else {
          options.onEvent?.({ event: "turn_failed", timestamp: new Date().toISOString(), session_id: sessionId });
          resolve({ status: "Failed", error: `command exited code=${code} signal=${signal}`, output });
        }
      });
    });
  }
}

function runMode(config: EffectiveConfig, issue: Issue): RunMode {
  if (issue.symphony_planning_mode) {
    return "planning";
  }
  const state = issue.state.trim().toLowerCase();
  if (config.linear.planningState && state === config.linear.planningState.trim().toLowerCase()) {
    return "planning";
  }
  return "implementation";
}

function issueForMode(issue: Issue, mode: RunMode): Issue {
  return {
    ...issue,
    symphony_planning_mode: mode === "planning",
    symphony_implementation_mode: mode === "implementation",
  };
}

function planComment(issue: Issue, output: string | null): string {
  const plan = output && output.trim().length > 0
    ? output.trim()
    : [
        `Plan for ${issue.identifier}: ${issue.title}`,
        "",
        "1. Inspect the relevant code and tests.",
        "2. Implement the smallest directly related change.",
        "3. Run the configured validation command and summarize the result.",
      ].join("\n");
  return plan.slice(0, 4000);
}

function validateLaunchCwd(workspaceRoot: string, workspacePath: string): void {
  if (!isPathInside(workspaceRoot, workspacePath)) {
    throw new Error(`launch cwd is outside issue workspace: ${workspacePath}`);
  }
  if (path.resolve(workspacePath) !== workspacePath) {
    throw new Error(`launch cwd must be absolute: ${workspacePath}`);
  }
}
