import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent, EffectiveConfig, Issue, JsonMap, Logger } from "./types.ts";
import { createLinearGraphqlToolClient, executeLinearGraphqlTool, linearGraphqlToolSpec } from "./linear-graphql-tool.ts";
import { errorMessage } from "./util.ts";

type PendingRequest = {
  resolve: (value: JsonMap) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface CodexAppServerOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  isStillActive?: () => Promise<boolean>;
}

export class CodexAppServerClient {
  private readonly config: EffectiveConfig;
  private readonly logger: Logger;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly earlyResponses = new Map<number, JsonMap>();
  private terminalTurnStatus: "completed" | "failed" | "cancelled" | null = null;
  private terminalTurnId: string | null = null;
  private terminalError: string | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private readonly outputChunks: string[] = [];

  constructor(config: EffectiveConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async run(issue: Issue, cwd: string, prompt: string, options: CodexAppServerOptions = {}): Promise<{ status: "Succeeded" | "Failed" | "TimedOut"; error: string | null; output: string | null }> {
    this.logger.info("codex app-server launching", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      cwd,
      command: this.config.codex.command,
    });
    this.child = spawn("bash", ["-lc", this.config.codex.command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const abort = () => this.child?.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8"), options));
    this.child.stderr.on("data", (chunk) => {
      this.logger.warn("codex app-server stderr", { message: chunk.toString("utf8").slice(0, 500) });
    });

    const exitPromise = new Promise<Error>((resolve) => {
      this.child?.on("error", (error) => resolve(error));
      this.child?.on("close", (code, signal) => resolve(new Error(`app-server exited code=${code} signal=${signal}`)));
    });

    const turnPromise = this.runProtocol(issue, cwd, prompt, options);
    let turnTimer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<{ status: "TimedOut"; error: string }>((resolve) => {
      turnTimer = setTimeout(() => {
        this.child?.kill("SIGTERM");
        resolve({ status: "TimedOut", error: `turn timed out after ${this.config.codex.turnTimeoutMs}ms`, output: this.output() });
      }, this.config.codex.turnTimeoutMs);
    });

    try {
      const result = await Promise.race([
        turnPromise,
        exitPromise.then((error) => ({ status: "Failed" as const, error: error.message, output: this.output() })),
        timeoutPromise,
      ]);
      return result;
    } finally {
      if (turnTimer) {
        clearTimeout(turnTimer);
      }
      options.signal?.removeEventListener("abort", abort);
      this.child?.kill("SIGTERM");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("app-server stopped"));
      }
      this.pending.clear();
    }
  }

  private async runProtocol(issue: Issue, cwd: string, prompt: string, options: CodexAppServerOptions): Promise<{ status: "Succeeded" | "Failed"; error: string | null; output: string | null }> {
    await this.request("initialize", {
      clientInfo: { name: "symphony-ts", title: "Symphony TS", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");

    const threadResponse = await this.request("thread/start", {
      cwd,
      approvalPolicy: this.config.codex.approvalPolicy ?? "never",
      sandbox: this.config.codex.threadSandbox ?? "workspace-write",
      dynamicTools: [linearGraphqlToolSpec()],
      developerInstructions: "A client-side dynamic tool named linear_graphql is available for Linear GraphQL operations. Use it for Linear issue comments, status changes, and PR link updates when the workflow asks you to update Linear.",
      serviceName: "symphony-ts",
      ephemeral: true,
      sessionStartSource: "startup",
    });
    this.threadId = getString(threadResponse, ["thread", "id"]);
    if (!this.threadId) {
      throw new Error("response_error: missing thread id");
    }

    const maxTurns = this.config.agent.maxTurns;
    let turnCount = 0;
    let turnInput = prompt;

    while (turnCount < maxTurns) {
      if (options.signal?.aborted) {
        return { status: "Failed", error: "cancelled", output: this.output() };
      }

      const turnResponse = await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: turnInput, text_elements: [] }],
        cwd,
        title: `${issue.identifier}: ${issue.title}`,
        approvalPolicy: this.config.codex.approvalPolicy ?? "never",
        sandboxPolicy: this.config.codex.turnSandboxPolicy ?? {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
      this.turnId = getString(turnResponse, ["turn", "id"]);
      if (!this.turnId) {
        throw new Error("response_error: missing turn id");
      }

      turnCount++;
      const sessionId = `${this.threadId}-${this.turnId}`;
      options.onEvent?.({
        event: "session_started",
        timestamp: new Date().toISOString(),
        codex_app_server_pid: this.child?.pid ? String(this.child.pid) : null,
        session_id: sessionId,
        turn_count: turnCount,
      });

      while (!this.terminalTurnStatus || this.terminalTurnId !== this.turnId) {
        if (options.signal?.aborted) {
          return { status: "Failed", error: "cancelled", output: this.output() };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      if (this.terminalTurnStatus !== "completed") {
        options.onEvent?.({ event: "turn_failed", timestamp: new Date().toISOString(), session_id: sessionId });
        return { status: "Failed", error: this.terminalError ?? this.terminalTurnStatus, output: this.output() };
      }

      options.onEvent?.({ event: "turn_completed", timestamp: new Date().toISOString(), session_id: sessionId });

      if (turnCount >= maxTurns || !options.isStillActive) {
        break;
      }

      let stillActive = false;
      try {
        stillActive = await options.isStillActive();
      } catch {
        break;
      }
      if (!stillActive) {
        break;
      }

      turnInput = "Continue working on the issue. Check the current state and complete any remaining work.";
    }

    return { status: "Succeeded", error: null, output: this.output() };
  }

  private request(method: string, params: unknown): Promise<JsonMap> {
    if (!this.child) {
      return Promise.reject(new Error("app-server not started"));
    }
    const id = this.nextRequestId++;
    const payload = { id, method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    const early = this.earlyResponses.get(id);
    if (early) {
      this.earlyResponses.delete(id);
      return Promise.resolve(early);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`response_timeout: ${method}`));
      }, this.config.codex.readTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown = {}): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: unknown, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private handleStdout(chunk: string, options: CodexAppServerOptions): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      this.handleMessageLine(line, options);
    }
  }

  private handleMessageLine(line: string, options: CodexAppServerOptions): void {
    let message: JsonMap;
    try {
      message = JSON.parse(line) as JsonMap;
    } catch {
      options.onEvent?.({ event: "malformed", timestamp: new Date().toISOString(), message: line.slice(0, 500) });
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) {
        if (!message.error) {
          this.earlyResponses.set(id, (message.result ?? {}) as JsonMap);
        }
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve((message.result ?? {}) as JsonMap);
      }
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message, options);
    }
  }

  private handleNotification(message: JsonMap, options: CodexAppServerOptions): void {
    const method = String(message.method);
    const params = isObject(message.params) ? message.params : {};
    if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
      this.captureOutput(params);
      const rawStatus = getString(params, ["turn", "status"]) ?? method.split("/")[1]!;
      this.terminalTurnId = getString(params, ["turn", "id"]) ?? this.turnId;
      this.terminalTurnStatus = rawStatus === "completed" ? "completed" : rawStatus === "cancelled" ? "cancelled" : "failed";
      this.terminalError = this.terminalTurnStatus === "completed" ? null : JSON.stringify(params);
    } else if (method === "error") {
      this.terminalTurnId = this.turnId;
      this.terminalTurnStatus = "failed";
      this.terminalError = JSON.stringify(params.error ?? params);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = tokenUsage(params);
      options.onEvent?.({ event: method, timestamp: new Date().toISOString(), session_id: this.sessionId(), usage });
    } else {
      this.captureOutput(params);
      options.onEvent?.({ event: method, timestamp: new Date().toISOString(), session_id: this.sessionId(), message: JSON.stringify(params).slice(0, 500) });
    }
  }

  private handleServerRequest(message: JsonMap): void {
    const method = String(message.method);
    if (method === "item/commandExecution/requestApproval") {
      this.respond(message.id, { decision: "acceptForSession" });
    } else if (method === "item/fileChange/requestApproval") {
      this.respond(message.id, { decision: "acceptForSession" });
    } else if (method === "item/tool/requestUserInput") {
      this.terminalTurnId = this.turnId;
      this.terminalTurnStatus = "failed";
      this.terminalError = "turn_input_required";
      this.respond(message.id, { answers: {} });
    } else if (method === "item/tool/call") {
      this.handleDynamicToolCall(message).catch((error) => {
        this.respond(message.id, toolResponse(false, { error: errorMessage(error) }));
      });
    } else {
      this.respond(message.id, { error: "unsupported_server_request" });
    }
  }

  private async handleDynamicToolCall(message: JsonMap): Promise<void> {
    const params = isObject(message.params) ? message.params : {};
    if (params.tool !== "linear_graphql") {
      this.respond(message.id, toolResponse(false, { error: "unsupported_tool_call" }));
      return;
    }
    if (!this.config.tracker.apiKey) {
      this.respond(message.id, toolResponse(false, { error: "missing_tracker_api_key" }));
      return;
    }
    const result = await executeLinearGraphqlTool(
      params.arguments,
      createLinearGraphqlToolClient(this.config.tracker.endpoint, this.config.tracker.apiKey),
    );
    this.respond(message.id, toolResponse(result.success, result));
  }

  private sessionId(): string | null {
    return this.threadId && this.turnId ? `${this.threadId}-${this.turnId}` : null;
  }

  private captureOutput(params: JsonMap): void {
    for (const text of textValues(params)) {
      if (text.trim().length > 0) {
        this.outputChunks.push(text.trim());
      }
    }
  }

  private output(): string | null {
    const joined = uniqueInOrder(this.outputChunks).join("\n\n").trim();
    return joined.length > 0 ? joined.slice(0, 4000) : null;
  }
}

function toolResponse(success: boolean, payload: unknown): JsonMap {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
  };
}

function tokenUsage(params: JsonMap): AgentEvent["usage"] {
  const usage = isObject(params.usage) ? params.usage : isObject(params.tokenUsage) ? params.tokenUsage : params;
  return {
    input_tokens: numberAt(usage, ["inputTokens"]),
    output_tokens: numberAt(usage, ["outputTokens"]),
    total_tokens: numberAt(usage, ["totalTokens"]),
  };
}

function numberAt(source: JsonMap, path: string[]): number | undefined {
  let current: unknown = source;
  for (const part of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "number" ? current : undefined;
}

function getString(source: JsonMap, path: string[]): string | null {
  let current: unknown = source;
  for (const part of path) {
    if (!isObject(current)) {
      return null;
    }
    current = current[part];
  }
  return typeof current === "string" ? current : null;
}

function isObject(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => textValues(item));
  }
  if (!isObject(value)) {
    return [];
  }
  const direct = typeof value.text === "string" ? [value.text] : [];
  const body = typeof value.body === "string" ? [value.body] : [];
  const content = "content" in value ? textValues(value.content) : [];
  const items = "items" in value ? textValues(value.items) : [];
  const item = "item" in value ? textValues(value.item) : [];
  const turn = "turn" in value ? textValues(value.turn) : [];
  return [...direct, ...body, ...content, ...items, ...item, ...turn];
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
