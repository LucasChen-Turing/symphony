import { LinearClient, type LinearGraphqlClient } from "./linear-client.ts";
import { SYMPHONY_PLAN_MARKER, SYMPHONY_RUN_REPORT_MARKER } from "./linear-tracker.ts";
import type { EffectiveConfig, Issue, JsonMap, Logger } from "./types.ts";

export class LinearWriteback {
  private readonly config: EffectiveConfig;
  private readonly logger: Logger;
  private readonly client: LinearGraphqlClient | null;

  constructor(config: EffectiveConfig, logger: Logger, client?: LinearGraphqlClient) {
    this.config = config;
    this.logger = logger;
    this.client = client ?? (config.linear.writeback && config.tracker.apiKey
      ? new LinearClient(config.tracker.endpoint, config.tracker.apiKey)
      : null);
  }

  async markRunning(issue: Issue): Promise<void> {
    if (!this.enabled()) return;
    await this.updateStatusIfConfigured(issue, this.config.linear.implementationState ?? this.config.linear.runningStatus);
  }

  async markPlan(issue: Issue, body: string): Promise<void> {
    if (!this.enabled()) return;
    await this.addComment(issue, withPlanMarker(body));
    await this.updateStatusIfConfigured(issue, this.config.linear.planReviewStatus);
  }

  async markReview(issue: Issue, body: string): Promise<void> {
    if (!this.enabled()) return;
    await this.addComment(issue, withRunReportMarker(body));
    await this.updateStatusIfConfigured(issue, this.config.linear.reviewStatus);
  }

  async markFailed(issue: Issue, body: string): Promise<void> {
    if (!this.enabled()) return;
    await this.addComment(issue, withRunReportMarker(body));
    await this.updateStatusIfConfigured(issue, this.config.linear.failedStatus);
  }

  private enabled(): boolean {
    return this.config.linear.writeback && this.config.tracker.kind === "linear" && this.client !== null;
  }

  private async addComment(issue: Issue, body: string): Promise<void> {
    try {
      await this.requireClient().query(`mutation SymphonyComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url }
  }
}`, { issueId: issue.id, body });
      this.logger.info("linear comment created", { issue_id: issue.id, issue_identifier: issue.identifier });
    } catch (error) {
      this.logger.warn("linear comment failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateStatusIfConfigured(issue: Issue, statusName: string | null): Promise<void> {
    if (!statusName) return;
    if (!this.config.tracker.teamKey) {
      this.logger.warn("linear status update skipped; tracker.team_key is required", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        status: statusName,
      });
      return;
    }

    try {
      const stateId = await this.findStateId(statusName);
      if (!stateId) {
        this.logger.warn("linear status update skipped; status not found", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          status: statusName,
        });
        return;
      }
      await this.requireClient().query(`mutation SymphonyIssueStatus($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier }
  }
}`, { issueId: issue.id, stateId });
      this.logger.info("linear status updated", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        status: statusName,
      });
    } catch (error) {
      this.logger.warn("linear status update failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        status: statusName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async findStateId(statusName: string): Promise<string | null> {
    const response = await this.requireClient().query(`query SymphonyWorkflowState($teamKey: String!, $statusName: String!) {
  workflowStates(first: 20, filter: { team: { key: { eq: $teamKey } }, name: { eq: $statusName } }) {
    nodes { id name }
  }
}`, { teamKey: this.config.tracker.teamKey!, statusName });
    const nodes = nodesAt(response.data, ["workflowStates", "nodes"]);
    return typeof nodes[0]?.id === "string" ? nodes[0].id : null;
  }

  private requireClient(): LinearGraphqlClient {
    if (!this.client) {
      throw new Error("linear writeback is not configured");
    }
    return this.client;
  }
}

function nodesAt(data: JsonMap | undefined, path: string[]): JsonMap[] {
  let current: unknown = data;
  for (const part of path) {
    if (!isObject(current)) {
      return [];
    }
    current = current[part];
  }
  return Array.isArray(current) ? current.filter(isObject) : [];
}

function isObject(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withRunReportMarker(body: string): string {
  return body.includes(SYMPHONY_RUN_REPORT_MARKER) ? body : `${SYMPHONY_RUN_REPORT_MARKER}\n${body}`;
}

function withPlanMarker(body: string): string {
  return body.includes(SYMPHONY_PLAN_MARKER) ? body : `${SYMPHONY_PLAN_MARKER}\n${body}`;
}
