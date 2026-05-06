import { AgentRunner } from "./agent-runner.ts";
import { validateForDispatch } from "./config.ts";
import { LinearWriteback } from "./linear-writeback.ts";
import { classifyPlanReviewFeedback } from "./plan-review.ts";
import type { AgentEvent, CodexTotals, EffectiveConfig, Issue, Logger, RunAttempt, RunningRow, Tracker } from "./types.ts";
import { createTracker } from "./tracker.ts";
import { errorMessage, normalizeState, sleep } from "./util.ts";
import { WorkspaceManager } from "./workspace.ts";
import { WorkflowStore } from "./workflow-store.ts";

const CONTINUATION_RETRY_DELAY_MS = 1000;
const FAILURE_RETRY_BASE_MS = 10000;

interface RunningEntry {
  issue: Issue;
  attempt: number | null;
  startedAt: number;
  abortController: AbortController;
  lastCodexTimestamp: number | null;
  lastCodexEvent: string | null;
  lastCodexMessage: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  error: string | null;
}

export interface RuntimeSnapshot {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: RunningRow[];
  claimed: string[];
  retries: Array<{ issue_id: string; identifier: string; attempt: number; due_at_ms: number; error: string | null }>;
  completed: string[];
  codex_totals: CodexTotals;
  codex_rate_limits: unknown;
}

export interface OrchestratorOptions {
  once?: boolean;
  enableRetries?: boolean;
}

export class Orchestrator {
  private readonly workflowStore: WorkflowStore;
  private readonly logger: Logger;
  private readonly options: OrchestratorOptions;
  private config: EffectiveConfig | null = null;
  private tracker: Tracker | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retries = new Map<string, RetryEntry>();
  private completed = new Set<string>();
  private codexTotals: CodexTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };
  private codexRateLimits: unknown = null;

  constructor(
    workflowStore: WorkflowStore,
    logger: Logger,
    options: OrchestratorOptions = {},
  ) {
    this.workflowStore = workflowStore;
    this.logger = logger;
    this.options = options;
  }

  async start(): Promise<void> {
    const loaded = await this.workflowStore.loadInitial();
    this.config = loaded.config;
    validateForDispatch(this.config);
    this.tracker = createTracker(this.config);
    await this.startupTerminalCleanup();
    await this.tick();
    if (!this.options.once) {
      this.scheduleNextTick();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const retry of this.retries.values()) {
      clearTimeout(retry.timer);
    }
    this.retries.clear();
    for (const running of this.running.values()) {
      running.abortController.abort();
    }
    await this.waitForIdle(10000);
  }

  async waitForIdle(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(25);
    }
  }

  snapshot(): RuntimeSnapshot {
    const activeSeconds = Array.from(this.running.values()).reduce(
      (sum, entry) => sum + (Date.now() - entry.startedAt) / 1000,
      0,
    );
    return {
      pollIntervalMs: this.config?.polling.intervalMs ?? 0,
      maxConcurrentAgents: this.config?.agent.maxConcurrentAgents ?? 0,
      running: Array.from(this.running.entries()).map(([issueId, entry]) => ({
        issue_id: issueId,
        issue_identifier: entry.issue.identifier,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        started_at: entry.startedAt,
        workspace_path: entry.workspacePath,
        last_event: entry.lastCodexEvent,
        last_message: entry.lastCodexMessage,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        total_tokens: entry.totalTokens,
      })),
      claimed: Array.from(this.claimed.values()),
      retries: Array.from(this.retries.values()).map((retry) => ({
        issue_id: retry.issueId,
        identifier: retry.identifier,
        attempt: retry.attempt,
        due_at_ms: retry.dueAtMs,
        error: retry.error,
      })),
      completed: Array.from(this.completed.values()),
      codex_totals: {
        ...this.codexTotals,
        seconds_running: this.codexTotals.seconds_running + activeSeconds,
      },
      codex_rate_limits: this.codexRateLimits,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    await this.refreshConfig();
    await this.reconcileRunning();

    try {
      if (!this.config) {
        throw new Error("config not loaded");
      }
      validateForDispatch(this.config);
    } catch (error) {
      this.logger.error("dispatch validation failed", { error: errorMessage(error) });
      return;
    }

    try {
      const candidates = await this.fetchCandidateIssues();
      await this.dispatchCandidates(candidates, null);
    } catch (error) {
      this.logger.error("candidate fetch failed", { error: errorMessage(error) });
    }
  }

  private async fetchCandidateIssues(): Promise<Issue[]> {
    if (!this.config?.linear.planReviewStatus) {
      return this.requireTracker().fetchCandidateIssues();
    }
    const [activeIssues, planReviewIssues] = await Promise.all([
      this.requireTracker().fetchCandidateIssues(),
      this.requireTracker().fetchIssuesByStates([this.config.linear.planReviewStatus]),
    ]);
    const byId = new Map<string, Issue>();
    for (const issue of [...activeIssues, ...planReviewIssues]) {
      byId.set(issue.id, issue);
    }
    return Array.from(byId.values());
  }

  private scheduleNextTick(): void {
    if (this.stopped || !this.config) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      await this.tick();
      this.scheduleNextTick();
    }, this.config.polling.intervalMs);
  }

  private async refreshConfig(): Promise<void> {
    try {
      const loaded = await this.workflowStore.getCurrent();
      this.config = loaded.config;
      this.tracker = createTracker(this.config);
    } catch (error) {
      this.logger.error("workflow reload failed; keeping last known config", { error: errorMessage(error) });
    }
  }

  private async startupTerminalCleanup(): Promise<void> {
    if (!this.config) {
      return;
    }
    try {
      const terminalIssues = await this.requireTracker().fetchIssuesByStates(this.config.tracker.terminalStates);
      const workspaceManager = new WorkspaceManager(this.config, this.logger);
      for (const issue of terminalIssues) {
        await workspaceManager.removeWorkspace(issue.identifier);
        this.logger.info("terminal workspace cleanup completed", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
      }
    } catch (error) {
      this.logger.warn("startup terminal cleanup failed; continuing", { error: errorMessage(error) });
    }
  }

  private async reconcileRunning(): Promise<void> {
    if (!this.config || this.running.size === 0) {
      return;
    }

    if (this.config.codex.stallTimeoutMs > 0) {
      for (const [issueId, running] of this.running) {
        const basis = running.lastCodexTimestamp ?? running.startedAt;
        if (Date.now() - basis > this.config.codex.stallTimeoutMs) {
          running.abortController.abort();
          this.releaseRunning(issueId);
          this.scheduleRetry(running.issue, nextAttempt(running.attempt), "stalled", false);
          this.logger.warn("running issue stalled; retrying", {
            issue_id: issueId,
            issue_identifier: running.issue.identifier,
          });
        }
      }
    }

    if (this.running.size === 0) {
      return;
    }

    try {
      const refreshed = await this.requireTracker().fetchIssueStatesByIds(Array.from(this.running.keys()));
      const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
      const terminal = stateSet(this.config.tracker.terminalStates);
      for (const [issueId, running] of this.running) {
        const issue = byId.get(issueId);
        if (!issue) {
          continue;
        }
        const state = normalizeState(issue.state);
        const active = stateSet(this.config.tracker.activeStates);
        if (running.issue.symphony_planning_mode && this.config.linear.planReviewStatus) {
          active.add(normalizeState(this.config.linear.planReviewStatus));
        }
        if (terminal.has(state)) {
          running.abortController.abort();
          this.releaseRunning(issueId);
          await new WorkspaceManager(this.config, this.logger).removeWorkspace(issue.identifier);
          this.logger.info("running issue reached terminal state; cleaned workspace", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
          });
        } else if (active.has(state)) {
          running.issue = issue;
        } else {
          running.abortController.abort();
          this.releaseRunning(issueId);
          this.logger.info("running issue no longer active; released", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            state: issue.state,
          });
        }
      }
    } catch (error) {
      this.logger.warn("running issue reconciliation failed; keeping workers running", { error: errorMessage(error) });
    }
  }

  private async dispatchCandidates(candidates: Issue[], specificIssueId: string | null): Promise<boolean> {
    if (!this.config) {
      return false;
    }
    const sorted = candidates
      .filter((issue) => specificIssueId === null || issue.id === specificIssueId)
      .sort(compareIssues);

    let dispatched = false;
    for (const issue of sorted) {
      if (await this.handlePlanReviewIssue(issue)) {
        dispatched = true;
        continue;
      }
      if (!this.isEligible(issue)) {
        continue;
      }
      if (this.availableGlobalSlots() <= 0) {
        break;
      }
      if (!this.hasStateSlot(issue.state)) {
        continue;
      }
      this.dispatchIssue(issue, null);
      dispatched = true;
    }
    return dispatched;
  }

  private async handlePlanReviewIssue(issue: Issue): Promise<boolean> {
    if (!this.config?.linear.planReviewStatus) {
      return false;
    }
    if (normalizeState(issue.state) !== normalizeState(this.config.linear.planReviewStatus)) {
      return false;
    }
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) {
      return false;
    }

    const intent = classifyPlanReviewFeedback(issue.plan_feedback_since_latest_plan);
    if (intent === "approve") {
      await new LinearWriteback(this.config, this.logger).markPlanApproved(issue);
      this.logger.info("plan review approved; issue promoted for implementation", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      return true;
    }
    if (intent !== "changes") {
      return false;
    }
    if (this.availableGlobalSlots() <= 0 || !this.hasStateSlot(issue.state)) {
      return false;
    }
    this.dispatchIssue({ ...issue, symphony_planning_mode: true, symphony_implementation_mode: false }, null);
    return true;
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    if (!this.config || this.running.has(issue.id) || this.claimed.has(issue.id)) {
      return;
    }
    this.claimed.add(issue.id);
    const abortController = new AbortController();
    const entry: RunningEntry = {
      issue,
      attempt,
      startedAt: Date.now(),
      abortController,
      lastCodexTimestamp: null,
      lastCodexEvent: null,
      lastCodexMessage: null,
      sessionId: null,
      workspacePath: null,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
    };
    this.running.set(issue.id, entry);
    this.logger.info("issue dispatched", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
    });

    const config = this.config;
    const isStillActive = async (): Promise<boolean> => {
      try {
        const refreshed = await this.requireTracker().fetchIssueStatesByIds([issue.id]);
        const found = refreshed.find((i) => i.id === issue.id);
        if (!found) return false;
        const state = normalizeState(found.state);
        const active = stateSet(config.tracker.activeStates);
        if (issue.symphony_planning_mode && config.linear.planReviewStatus) {
          active.add(normalizeState(config.linear.planReviewStatus));
        }
        return active.has(state) && !stateSet(config.tracker.terminalStates).has(state);
      } catch {
        return false;
      }
    };

    const runner = new AgentRunner(this.config, this.logger);
    runner
      .run(issue, attempt, {
        signal: abortController.signal,
        onEvent: (event) => this.integrateAgentEvent(issue.id, event),
        isStillActive,
      })
      .then((result) => this.handleRunComplete(result))
      .catch((error) => {
        this.handleRunComplete({
          issue,
          attempt,
          status: "Failed",
          workspacePath: "",
          startedAt: entry.startedAt,
          endedAt: Date.now(),
          error: errorMessage(error),
        });
      });
  }

  private handleRunComplete(result: RunAttempt): void {
    const entry = this.running.get(result.issue.id);
    if (entry) {
      this.codexTotals.seconds_running += (Date.now() - entry.startedAt) / 1000;
    }
    this.releaseRunning(result.issue.id);
    if (result.status === "Succeeded") {
      this.completed.add(result.issue.id);
      this.logger.info("agent run completed", {
        issue_id: result.issue.id,
        issue_identifier: result.issue.identifier,
        workspace_path: result.workspacePath,
      });
      if (this.options.enableRetries !== false && !this.options.once) {
        this.scheduleRetry(result.issue, 1, null, true);
      }
    } else {
      this.logger.warn("agent run failed; retrying", {
        issue_id: result.issue.id,
        issue_identifier: result.issue.identifier,
        status: result.status,
        error: result.error,
      });
      if (this.options.enableRetries !== false && !this.options.once) {
        this.scheduleRetry(result.issue, nextAttempt(result.attempt), result.error ?? result.status, false);
      }
    }
  }

  private scheduleRetry(issue: Issue, attempt: number, error: string | null, continuation: boolean): void {
    if (!this.config) {
      return;
    }
    const previous = this.retries.get(issue.id);
    if (previous) {
      clearTimeout(previous.timer);
    }
    const delay = continuation
      ? CONTINUATION_RETRY_DELAY_MS
      : Math.min(FAILURE_RETRY_BASE_MS * 2 ** (attempt - 1), this.config.agent.maxRetryBackoffMs);
    const retry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAtMs: Date.now() + delay,
      error,
      timer: setTimeout(() => this.handleRetry(issue.id), delay),
    };
    this.retries.set(issue.id, retry);
    this.claimed.add(issue.id);
    this.logger.info("issue retry scheduled", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      delay_ms: delay,
      error,
    });
  }

  private async handleRetry(issueId: string): Promise<void> {
    const retry = this.retries.get(issueId);
    if (!retry) {
      return;
    }
    this.retries.delete(issueId);
    this.claimed.delete(issueId);
    try {
      await this.refreshConfig();
      const candidates = await this.fetchCandidateIssues();
      const issue = candidates.find((candidate) => candidate.id === issueId);
      if (issue && await this.handlePlanReviewIssue(issue)) {
        return;
      }
      if (!issue || !this.isEligible(issue)) {
        this.claimed.delete(issueId);
        this.logger.info("retry released; issue no longer eligible", {
          issue_id: issueId,
          issue_identifier: retry.identifier,
        });
        return;
      }
      if (this.availableGlobalSlots() <= 0 || !this.hasStateSlot(issue.state)) {
        this.scheduleRetry(issue, retry.attempt, "no available orchestrator slots", false);
        return;
      }
      this.dispatchIssue(issue, retry.attempt);
    } catch (error) {
      this.logger.warn("retry failed to fetch candidates; requeueing", {
        issue_id: issueId,
        issue_identifier: retry.identifier,
        error: errorMessage(error),
      });
      const issue = retryToIssue(retry);
      this.scheduleRetry(issue, retry.attempt + 1, errorMessage(error), false);
    }
  }

  private isEligible(issue: Issue): boolean {
    if (!this.config) {
      return false;
    }
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return false;
    }
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) {
      return false;
    }
    const state = normalizeState(issue.state);
    if (this.config.linear.planReviewStatus && state === normalizeState(this.config.linear.planReviewStatus)) {
      return false;
    }
    if (!stateSet(this.config.tracker.activeStates).has(state) || stateSet(this.config.tracker.terminalStates).has(state)) {
      return false;
    }
    if (state === "todo") {
      const terminal = stateSet(this.config.tracker.terminalStates);
      if (issue.blocked_by.some((blocker) => !terminal.has(normalizeState(blocker.state)))) {
        return false;
      }
    }
    return true;
  }

  private integrateAgentEvent(issueId: string, event: AgentEvent): void {
    const running = this.running.get(issueId);
    if (!running) {
      return;
    }
    running.lastCodexTimestamp = Date.parse(event.timestamp) || Date.now();
    running.lastCodexEvent = event.event;
    running.lastCodexMessage = event.message ?? null;
    running.sessionId = event.session_id ?? running.sessionId;

    if (event.turn_count !== undefined) {
      running.turnCount = event.turn_count;
    }
    if (event.workspace_path) {
      running.workspacePath = event.workspace_path;
    }

    if (event.event === "thread/tokenUsage/updated" && event.usage) {
      const input = event.usage.input_tokens ?? 0;
      const output = event.usage.output_tokens ?? 0;
      const total = event.usage.total_tokens ?? 0;
      const deltaInput = Math.max(0, input - running.lastReportedInputTokens);
      const deltaOutput = Math.max(0, output - running.lastReportedOutputTokens);
      const deltaTotal = Math.max(0, total - running.lastReportedTotalTokens);
      this.codexTotals.input_tokens += deltaInput;
      this.codexTotals.output_tokens += deltaOutput;
      this.codexTotals.total_tokens += deltaTotal;
      running.lastReportedInputTokens = input;
      running.lastReportedOutputTokens = output;
      running.lastReportedTotalTokens = total;
      running.inputTokens += deltaInput;
      running.outputTokens += deltaOutput;
      running.totalTokens += deltaTotal;
    }
  }

  private releaseRunning(issueId: string): void {
    this.running.delete(issueId);
    this.claimed.delete(issueId);
  }

  private availableGlobalSlots(): number {
    return Math.max((this.config?.agent.maxConcurrentAgents ?? 0) - this.running.size, 0);
  }

  private hasStateSlot(stateName: string): boolean {
    if (!this.config) {
      return false;
    }
    const state = normalizeState(stateName);
    const limit = this.config.agent.maxConcurrentAgentsByState.get(state) ?? this.config.agent.maxConcurrentAgents;
    const runningInState = Array.from(this.running.values()).filter((entry) => normalizeState(entry.issue.state) === state).length;
    return runningInState < limit;
  }

  private requireTracker(): Tracker {
    if (!this.tracker) {
      throw new Error("tracker not initialized");
    }
    return this.tracker;
  }
}

function stateSet(states: string[]): Set<string> {
  return new Set(states.map((state) => normalizeState(state)));
}

function nextAttempt(previous: number | null): number {
  return previous === null ? 1 : previous + 1;
}

function compareIssues(left: Issue, right: Issue): number {
  const leftPriority = left.priority ?? Number.POSITIVE_INFINITY;
  const rightPriority = right.priority ?? Number.POSITIVE_INFINITY;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  const leftCreated = left.created_at ? Date.parse(left.created_at) : Number.POSITIVE_INFINITY;
  const rightCreated = right.created_at ? Date.parse(right.created_at) : Number.POSITIVE_INFINITY;
  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }
  return left.identifier.localeCompare(right.identifier);
}

function retryToIssue(retry: RetryEntry): Issue {
  return {
    id: retry.issueId,
    identifier: retry.identifier,
    title: retry.identifier,
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    parent: null,
    url: null,
    labels: [],
    blocked_by: [],
    comments: [],
    comments_summary: "",
    feedback_since_last_run: [],
    feedback_since_last_run_summary: "",
    latest_symphony_plan: null,
    plan_feedback_since_latest_plan: [],
    plan_feedback_since_latest_plan_summary: "",
    symphony_planning_mode: false,
    symphony_implementation_mode: false,
    created_at: null,
    updated_at: null,
  };
}
