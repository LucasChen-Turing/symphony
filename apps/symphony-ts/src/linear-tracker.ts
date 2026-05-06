import { LinearClient, type LinearGraphqlClient } from "./linear-client.ts";
import type { EffectiveConfig, Issue, IssueComment, JsonMap, Tracker } from "./types.ts";
import { parseIsoOrNull } from "./util.ts";

export const SYMPHONY_RUN_REPORT_MARKER = "<!-- symphony:run-report -->";
export const SYMPHONY_PLAN_MARKER = "<!-- symphony:plan -->";

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export class LinearTracker implements Tracker {
  private readonly config: EffectiveConfig;
  private readonly client: LinearGraphqlClient;

  constructor(config: EffectiveConfig, client?: LinearGraphqlClient) {
    if (!config.tracker.apiKey && !client) {
      throw new Error("missing_tracker_api_key");
    }
    this.config = config;
    this.client = client ?? new LinearClient(config.tracker.endpoint, config.tracker.apiKey!, 30000);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesPageByPage(this.config.tracker.activeStates, this.config.tracker.limit);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    return this.fetchIssuesPageByPage(stateNames, this.config.tracker.limit);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }
    const query = `query SymphonyIssueStates($ids: [ID!]!, $first: Int!, $commentsFirst: Int!) {
  issues(first: $first, filter: { id: { in: $ids } }) {
    nodes {
      ${issueFields()}
    }
  }
}`;
    const response = await this.client.query(query, {
      ids: issueIds,
      first: Math.max(issueIds.length, 1),
      commentsFirst: this.config.tracker.commentsLimit,
    });
    return nodesAt(response.data, ["issues", "nodes"]).map((raw) => normalizeLinearIssue(raw, this.config.tracker.feedbackMaxChars)).filter((issue): issue is Issue => issue !== null);
  }

  private async fetchIssuesPageByPage(stateNames: string[], limit: number): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    while (issues.length < limit) {
      const first = Math.min(50, limit - issues.length);
      const { query, variables } = this.buildIssuesQuery(stateNames, first, after);
      const response = await this.client.query(query, variables);
      const pageIssues = nodesAt(response.data, ["issues", "nodes"])
        .map((raw) => normalizeLinearIssue(raw, this.config.tracker.feedbackMaxChars))
        .filter((issue): issue is Issue => issue !== null);
      issues.push(...pageIssues);

      const pageInfo = pageInfoAt(response.data, ["issues", "pageInfo"]);
      if (!pageInfo.hasNextPage) {
        break;
      }
      if (!pageInfo.endCursor) {
        throw new Error("linear_missing_end_cursor");
      }
      after = pageInfo.endCursor;
    }

    return issues.slice(0, limit);
  }

  private buildIssuesQuery(stateNames: string[], first: number, after: string | null): { query: string; variables: JsonMap } {
    const variableDefinitions = ["$first: Int!", "$after: String", "$stateNames: [String!]!", "$commentsFirst: Int!"];
    const filterParts = ["state: { name: { in: $stateNames } }"];
    const variables: JsonMap = { first, after, stateNames, commentsFirst: this.config.tracker.commentsLimit };

    if (this.config.tracker.teamKey) {
      variableDefinitions.push("$teamKey: String!");
      filterParts.push("team: { key: { eq: $teamKey } }");
      variables.teamKey = this.config.tracker.teamKey;
    }
    if (this.config.tracker.projectSlug) {
      variableDefinitions.push("$projectSlug: String!");
      filterParts.push("project: { slugId: { eq: $projectSlug } }");
      variables.projectSlug = this.config.tracker.projectSlug;
    }
    if (this.config.tracker.labels.length > 0) {
      variableDefinitions.push("$labelNames: [String!]!");
      filterParts.push("labels: { name: { in: $labelNames } }");
      variables.labelNames = this.config.tracker.labels;
    }

    const query = `query SymphonyIssues(${variableDefinitions.join(", ")}) {
  issues(first: $first, after: $after, filter: { ${filterParts.join(", ")} }) {
    nodes {
      ${issueFields()}
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;
    return { query, variables };
  }
}

function issueFields(): string {
  return `id
      identifier
      title
      description
      priority
      branchName
      url
      createdAt
      updatedAt
      state { name }
      labels { nodes { name } }
      comments(first: $commentsFirst) { nodes { id body createdAt user { name displayName } } }
      relations { nodes { type relatedIssue { id identifier state { name } } issue { id identifier state { name } } } }
      inverseRelations { nodes { type relatedIssue { id identifier state { name } } issue { id identifier state { name } } } }`;
}

export function normalizeLinearIssue(raw: unknown, feedbackMaxChars = 4000): Issue | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = stringValue(raw.id);
  const identifier = stringValue(raw.identifier);
  const title = stringValue(raw.title);
  const state = stateName(raw.state);
  if (!id || !identifier || !title || !state) {
    return null;
  }

  const comments = normalizeComments(raw.comments);
  const feedback = feedbackSinceLastRun(comments, feedbackMaxChars);
  const latestPlan = latestSymphonyPlan(comments);
  const planFeedback = feedbackSinceLatestPlan(comments, feedbackMaxChars);

  return {
    id,
    identifier,
    title,
    description: stringValue(raw.description),
    priority: Number.isInteger(raw.priority) ? Number(raw.priority) : null,
    state,
    branch_name: stringValue(raw.branchName) ?? stringValue(raw.branch_name),
    url: stringValue(raw.url),
    labels: connectionNodes(raw.labels).map((label) => stringValue(label.name)).filter((label): label is string => label !== null).map((label) => label.toLowerCase()),
    blocked_by: blockedBy(raw),
    comments,
    comments_summary: summarizeComments(comments, feedbackMaxChars),
    feedback_since_last_run: feedback,
    feedback_since_last_run_summary: summarizeComments(feedback, feedbackMaxChars),
    latest_symphony_plan: latestPlan,
    plan_feedback_since_latest_plan: planFeedback,
    plan_feedback_since_latest_plan_summary: summarizeComments(planFeedback, feedbackMaxChars),
    symphony_planning_mode: false,
    symphony_implementation_mode: false,
    created_at: parseIsoOrNull(raw.createdAt ?? raw.created_at),
    updated_at: parseIsoOrNull(raw.updatedAt ?? raw.updated_at),
  };
}

export function feedbackSinceLastRun(comments: IssueComment[], maxChars = 4000): IssueComment[] {
  let startIndex = 0;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (comments[index]!.body.includes(SYMPHONY_RUN_REPORT_MARKER)) {
      startIndex = index + 1;
      break;
    }
  }

  const feedback: IssueComment[] = [];
  let total = 0;
  for (const comment of comments.slice(startIndex)) {
    if (comment.body.includes(SYMPHONY_RUN_REPORT_MARKER) || comment.body.includes(SYMPHONY_PLAN_MARKER)) {
      continue;
    }
    const remaining = Math.max(maxChars - total, 0);
    if (remaining <= 0) break;
    const body = comment.body.length > remaining ? `${comment.body.slice(0, Math.max(remaining - 15, 0))}\n[truncated]` : comment.body;
    total += body.length;
    feedback.push({ ...comment, body });
  }
  return feedback;
}

export function latestSymphonyPlan(comments: IssueComment[]): string | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const body = comments[index]!.body;
    if (body.includes(SYMPHONY_PLAN_MARKER)) {
      return body.replace(SYMPHONY_PLAN_MARKER, "").trim() || null;
    }
  }
  return null;
}

export function feedbackSinceLatestPlan(comments: IssueComment[], maxChars = 4000): IssueComment[] {
  let startIndex = -1;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (comments[index]!.body.includes(SYMPHONY_PLAN_MARKER)) {
      startIndex = index + 1;
      break;
    }
  }
  if (startIndex === -1) {
    return [];
  }

  const feedback: IssueComment[] = [];
  let total = 0;
  for (const comment of comments.slice(startIndex)) {
    if (comment.body.includes(SYMPHONY_PLAN_MARKER) || comment.body.includes(SYMPHONY_RUN_REPORT_MARKER)) {
      continue;
    }
    const remaining = Math.max(maxChars - total, 0);
    if (remaining <= 0) break;
    const body = comment.body.length > remaining ? `${comment.body.slice(0, Math.max(remaining - 15, 0))}\n[truncated]` : comment.body;
    total += body.length;
    feedback.push({ ...comment, body });
  }
  return feedback;
}

function normalizeComments(value: unknown): IssueComment[] {
  return connectionNodes(value)
    .map((comment) => {
      const id = stringValue(comment.id);
      const body = stringValue(comment.body);
      if (!id || !body) {
        return null;
      }
      const user = isObject(comment.user) ? comment.user : {};
      return {
        id,
        body,
        created_at: parseIsoOrNull(comment.createdAt ?? comment.created_at),
        user_name: stringValue(user.displayName) ?? stringValue(user.name),
      };
    })
    .filter((comment): comment is IssueComment => comment !== null)
    .sort((left, right) => timestampMs(left.created_at) - timestampMs(right.created_at));
}

function summarizeComments(comments: IssueComment[], maxChars: number): string {
  const summary = comments
    .map((comment) => {
      const author = comment.user_name ?? "Unknown";
      const timestamp = comment.created_at ?? "unknown time";
      return `- ${timestamp} ${author}: ${comment.body}`;
    })
    .join("\n");
  if (summary.length <= maxChars) {
    return summary;
  }
  return `${summary.slice(0, Math.max(maxChars - 15, 0))}\n[truncated]`;
}

function blockedBy(raw: JsonMap): Issue["blocked_by"] {
  return [...connectionNodes(raw.inverseRelations), ...connectionNodes(raw.relations)]
    .filter((relation) => stringValue(relation.type)?.toLowerCase() === "blocks")
    .map((relation) => {
      const related = isObject(relation.relatedIssue) ? relation.relatedIssue : isObject(relation.issue) ? relation.issue : {};
      return {
        id: stringValue(related.id),
        identifier: stringValue(related.identifier),
        state: stateName(related.state),
      };
    });
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

function pageInfoAt(data: JsonMap | undefined, path: string[]): PageInfo {
  let current: unknown = data;
  for (const part of path) {
    if (!isObject(current)) {
      return { hasNextPage: false, endCursor: null };
    }
    current = current[part];
  }
  if (!isObject(current)) {
    return { hasNextPage: false, endCursor: null };
  }
  return {
    hasNextPage: current.hasNextPage === true,
    endCursor: stringValue(current.endCursor),
  };
}

function connectionNodes(value: unknown): JsonMap[] {
  if (!isObject(value) || !Array.isArray(value.nodes)) {
    return [];
  }
  return value.nodes.filter(isObject);
}

function stateName(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return isObject(value) ? stringValue(value.name) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampMs(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}
