export type JsonMap = Record<string, unknown>;

export interface IssueBlocker {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface IssueComment {
  id: string;
  body: string;
  created_at: string | null;
  user_name: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  parent: {
    id: string | null;
    identifier: string | null;
    title: string | null;
  } | null;
  url: string | null;
  labels: string[];
  blocked_by: IssueBlocker[];
  comments: IssueComment[];
  comments_summary: string;
  feedback_since_last_run: IssueComment[];
  feedback_since_last_run_summary: string;
  latest_symphony_plan: string | null;
  plan_feedback_since_latest_plan: IssueComment[];
  plan_feedback_since_latest_plan_summary: string;
  symphony_planning_mode: boolean;
  symphony_implementation_mode: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: JsonMap;
  prompt_template: string;
}

export interface EffectiveConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: {
    kind: string;
    endpoint: string;
    apiKey: string | null;
    teamKey: string | null;
    projectSlug: string | null;
    activeStates: string[];
    terminalStates: string[];
    labels: string[];
    limit: number;
    commentsLimit: number;
    feedbackMaxChars: number;
    mockIssues: Issue[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  git: {
    enabled: boolean;
    repo: string | null;
    allowedRepos: string[];
    baseBranch: string;
    branchPrefix: string;
    subissueBase: "parent_issue_branch" | null;
    directory: string;
    validationCommand: string | null;
    commitAuthorName: string | null;
    commitAuthorEmail: string | null;
  };
  github: {
    createPr: boolean;
    draft: boolean;
    remote: string;
  };
  linear: {
    writeback: boolean;
    planningState: string | null;
    planReviewStatus: string | null;
    implementationState: string | null;
    runningStatus: string | null;
    reviewStatus: string | null;
    failedStatus: string | null;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Map<string, number>;
  };
  codex: {
    protocol: "command" | "app_server";
    command: string;
    approvalPolicy: unknown;
    threadSandbox: unknown;
    turnSandboxPolicy: unknown;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface Tracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

export interface Logger {
  info(message: string, context?: JsonMap): void;
  warn(message: string, context?: JsonMap): void;
  error(message: string, context?: JsonMap): void;
}

export interface AgentEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid?: string | null;
  session_id?: string | null;
  turn_count?: number;
  workspace_path?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  message?: string;
}

export interface GitWorkspace {
  workspacePath: string;
  runPath: string;
  branchName: string | null;
  prBaseBranch: string | null;
  repoUrl: string | null;
}

export interface HandoffResult {
  changed: boolean;
  branchName: string | null;
  commitSha: string | null;
  prUrl: string | null;
  validationOutput: string | null;
}

export interface RunningRow {
  issue_id: string;
  issue_identifier: string;
  session_id: string | null;
  turn_count: number;
  started_at: number;
  workspace_path: string | null;
  last_event: string | null;
  last_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RunAttempt {
  issue: Issue;
  attempt: number | null;
  status: "Succeeded" | "Failed" | "TimedOut" | "Stalled" | "CanceledByReconciliation";
  workspacePath: string;
  startedAt: number;
  endedAt: number;
  error: string | null;
}
