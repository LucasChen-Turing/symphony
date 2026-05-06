import os from "node:os";
import path from "node:path";
import type { EffectiveConfig, Issue, JsonMap } from "./types.ts";
import { asNonNegativeInteger, asPositiveInteger, normalizeState, parseIsoOrNull } from "./util.ts";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function resolveConfig(raw: JsonMap, workflowPath: string, env: NodeJS.ProcessEnv = process.env): EffectiveConfig {
  const workflowFile = path.resolve(workflowPath);
  const workflowDir = path.dirname(workflowFile);
  const tracker = objectAt(raw, "tracker");
  const polling = objectAt(raw, "polling");
  const workspace = objectAt(raw, "workspace");
  const hooks = objectAt(raw, "hooks");
  const git = objectAt(raw, "git");
  const github = objectAt(raw, "github");
  const linear = objectAt(raw, "linear");
  const agent = objectAt(raw, "agent");
  const codex = objectAt(raw, "codex");

  const trackerKind = stringAt(tracker, "kind") ?? "mock";
  const trackerApiKey = resolveEnvReference(stringAt(tracker, "api_key") ?? (trackerKind === "linear" ? "$LINEAR_API_KEY" : null), env);
  const activeStates = stringListAt(tracker, "active_states", stringListAt(tracker, "statuses", DEFAULT_ACTIVE_STATES));
  const terminalStates = stringListAt(tracker, "terminal_states", DEFAULT_TERMINAL_STATES);
  const workspaceRoot = resolveWorkspaceRoot(stringAt(workspace, "root") ?? path.join(os.tmpdir(), "symphony_workspaces"), workflowDir, env);
  const byState = positiveIntegerMapAt(agent, "max_concurrent_agents_by_state");

  return {
    workflowPath: workflowFile,
    workflowDir,
    tracker: {
      kind: trackerKind,
      endpoint: stringAt(tracker, "endpoint") ?? "https://api.linear.app/graphql",
      apiKey: trackerApiKey,
      teamKey: stringAt(tracker, "team_key") ?? stringAt(tracker, "teamKey"),
      projectSlug: stringAt(tracker, "project_slug"),
      activeStates,
      terminalStates,
      labels: stringListAt(tracker, "labels", []),
      limit: asPositiveInteger(tracker.limit, 50),
      commentsLimit: asPositiveInteger(tracker.comments_limit, 50),
      feedbackMaxChars: asPositiveInteger(tracker.feedback_max_chars, 4000),
      mockIssues: normalizeIssues(arrayAt(tracker, "issues")),
    },
    polling: {
      intervalMs: asPositiveInteger(polling.interval_ms, 30000),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: nullableStringAt(hooks, "after_create"),
      beforeRun: nullableStringAt(hooks, "before_run"),
      afterRun: nullableStringAt(hooks, "after_run"),
      beforeRemove: nullableStringAt(hooks, "before_remove"),
      timeoutMs: asPositiveInteger(hooks.timeout_ms, 60000),
    },
    git: {
      enabled: booleanAt(git, "enabled", false),
      repo: nullableStringAt(git, "repo"),
      allowedRepos: stringListAt(git, "allowed_repos", []),
      baseBranch: stringAt(git, "base_branch") ?? "main",
      branchPrefix: stringAt(git, "branch_prefix") ?? "symphony",
      directory: stringAt(git, "directory") ?? "repo",
      validationCommand: nullableStringAt(git, "validation_command"),
      commitAuthorName: nullableStringAt(git, "commit_author_name"),
      commitAuthorEmail: nullableStringAt(git, "commit_author_email"),
    },
    github: {
      createPr: booleanAt(github, "create_pr", false),
      draft: booleanAt(github, "draft", true),
      remote: stringAt(github, "remote") ?? "origin",
    },
    linear: {
      writeback: booleanAt(linear, "writeback", false),
      planningState: nullableStringAt(linear, "planning_state"),
      planReviewStatus: nullableStringAt(linear, "plan_review_status"),
      implementationState: nullableStringAt(linear, "implementation_state"),
      runningStatus: nullableStringAt(linear, "running_status"),
      reviewStatus: nullableStringAt(linear, "review_status"),
      failedStatus: nullableStringAt(linear, "failed_status"),
    },
    agent: {
      maxConcurrentAgents: asPositiveInteger(agent.max_concurrent_agents, 10),
      maxTurns: asPositiveInteger(agent.max_turns, 20),
      maxRetryBackoffMs: asPositiveInteger(agent.max_retry_backoff_ms, 300000),
      maxConcurrentAgentsByState: byState,
    },
    codex: {
      protocol: codexProtocol(stringAt(codex, "protocol")),
      command: stringAt(codex, "command") ?? "codex app-server",
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy,
      turnTimeoutMs: asPositiveInteger(codex.turn_timeout_ms, 3600000),
      readTimeoutMs: asPositiveInteger(codex.read_timeout_ms, 5000),
      stallTimeoutMs: asNonNegativeInteger(codex.stall_timeout_ms, 300000),
    },
  };
}

function codexProtocol(value: string | null): "command" | "app_server" {
  return value === "app_server" ? "app_server" : "command";
}

export function validateForDispatch(config: EffectiveConfig): void {
  if (config.tracker.kind !== "mock" && config.tracker.kind !== "linear") {
    throw new ConfigError(`unsupported_tracker_kind: ${config.tracker.kind}`);
  }
  if (config.tracker.kind === "linear") {
    if (!config.tracker.apiKey) {
      throw new ConfigError("missing_tracker_api_key");
    }
    if (!config.tracker.teamKey && !config.tracker.projectSlug) {
      throw new ConfigError("missing_linear_scope: tracker.team_key or tracker.project_slug is required");
    }
  }
  if (!config.codex.command.trim()) {
    throw new ConfigError("codex.command is required");
  }
  if (config.agent.maxTurns <= 0) {
    throw new ConfigError("agent.max_turns must be positive");
  }
  if (config.hooks.timeoutMs <= 0) {
    throw new ConfigError("hooks.timeout_ms must be positive");
  }
  if (config.git.enabled) {
    if (!config.git.repo) {
      throw new ConfigError("missing_git_repo");
    }
    if (config.git.allowedRepos.length > 0 && !config.git.allowedRepos.includes(config.git.repo)) {
      throw new ConfigError("git_repo_not_allowed");
    }
    if (config.git.baseBranch.trim().length === 0) {
      throw new ConfigError("git.base_branch is required");
    }
    if (config.git.branchPrefix.trim().length === 0) {
      throw new ConfigError("git.branch_prefix is required");
    }
    if (config.github.createPr && config.github.remote.trim().length === 0) {
      throw new ConfigError("github.remote is required");
    }
  }
}

function objectAt(source: JsonMap, key: string): JsonMap {
  const value = source[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonMap : {};
}

function arrayAt(source: JsonMap, key: string): unknown[] {
  return Array.isArray(source[key]) ? source[key] as unknown[] : [];
}

function stringAt(source: JsonMap, key: string): string | null {
  return typeof source[key] === "string" ? source[key] as string : null;
}

function nullableStringAt(source: JsonMap, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanAt(source: JsonMap, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringListAt(source: JsonMap, key: string, fallback: string[]): string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return fallback;
  }
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length > 0 ? strings : fallback;
}

function positiveIntegerMapAt(source: JsonMap, key: string): Map<string, number> {
  const result = new Map<string, number>();
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return result;
  }
  for (const [state, limit] of Object.entries(value as JsonMap)) {
    if (Number.isInteger(limit) && Number(limit) > 0) {
      result.set(normalizeState(state), Number(limit));
    }
  }
  return result;
}

function resolveEnvReference(value: string | null, env: NodeJS.ProcessEnv): string | null {
  if (!value) {
    return null;
  }
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const resolved = env[value.slice(1)] ?? "";
    return resolved.trim().length === 0 ? null : resolved;
  }
  return value;
}

function resolveWorkspaceRoot(root: string, workflowDir: string, env: NodeJS.ProcessEnv): string {
  let expanded = resolveEnvReference(root, env) ?? root;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workflowDir, expanded));
}

function normalizeIssues(entries: unknown[]): Issue[] {
  return entries
    .filter((entry): entry is JsonMap => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .map((entry, index) => normalizeIssue(entry, index))
    .filter((issue): issue is Issue => issue !== null);
}

function normalizeIssue(entry: JsonMap, index: number): Issue | null {
  const id = stringValue(entry.id) ?? `mock-${index + 1}`;
  const identifier = stringValue(entry.identifier);
  const title = stringValue(entry.title);
  const state = stringValue(entry.state);
  if (!identifier || !title || !state) {
    return null;
  }
  return {
    id,
    identifier,
    title,
    description: stringValue(entry.description),
    priority: Number.isInteger(entry.priority) ? Number(entry.priority) : null,
    state,
    branch_name: stringValue(entry.branch_name),
    url: stringValue(entry.url),
    labels: Array.isArray(entry.labels)
      ? entry.labels.filter((label): label is string => typeof label === "string").map((label) => label.toLowerCase())
      : [],
    blocked_by: Array.isArray(entry.blocked_by)
      ? entry.blocked_by
          .filter((blocker): blocker is JsonMap => typeof blocker === "object" && blocker !== null && !Array.isArray(blocker))
          .map((blocker) => ({
            id: stringValue(blocker.id),
            identifier: stringValue(blocker.identifier),
            state: stringValue(blocker.state),
          }))
      : [],
    comments: normalizeMockComments(entry.comments),
    comments_summary: "",
    feedback_since_last_run: [],
    feedback_since_last_run_summary: "",
    latest_symphony_plan: stringValue(entry.latest_symphony_plan),
    plan_feedback_since_latest_plan: normalizeMockComments(entry.plan_feedback_since_latest_plan),
    plan_feedback_since_latest_plan_summary: stringValue(entry.plan_feedback_since_latest_plan_summary) ?? "",
    symphony_planning_mode: false,
    symphony_implementation_mode: false,
    created_at: parseIsoOrNull(entry.created_at),
    updated_at: parseIsoOrNull(entry.updated_at),
  };
}

function normalizeMockComments(value: unknown): Issue["comments"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((comment): comment is JsonMap => typeof comment === "object" && comment !== null && !Array.isArray(comment))
    .map((comment, index) => ({
      id: stringValue(comment.id) ?? `comment-${index + 1}`,
      body: stringValue(comment.body) ?? "",
      created_at: parseIsoOrNull(comment.created_at),
      user_name: stringValue(comment.user_name),
    }))
    .filter((comment) => comment.body.length > 0);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
