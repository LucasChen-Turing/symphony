import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import {
  LinearTracker,
  SYMPHONY_PLAN_MARKER,
  SYMPHONY_RUN_REPORT_MARKER,
  feedbackSinceLastRun,
  feedbackSinceLatestPlan,
  normalizeLinearIssue,
} from "../src/linear-tracker.ts";
import type { JsonMap } from "../src/types.ts";

class MockLinearClient {
  calls: Array<{ query: string; variables: JsonMap }> = [];
  private readonly responses: Array<{ data: JsonMap }> = [];

  constructor(responses: Array<{ data: JsonMap }>) {
    this.responses = responses;
  }

  async query(query: string, variables: JsonMap): Promise<{ data: JsonMap }> {
    this.calls.push({ query, variables });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("missing mock response");
    }
    return response;
  }
}

test("LinearTracker fetches candidate issues with configured filters and pagination", async () => {
  const config = resolveConfig({
    tracker: {
      kind: "linear",
      team_key: "ENG",
      project_slug: "ai-project",
      active_states: ["Ready for AI"],
      labels: ["codex"],
      limit: 2,
      comments_limit: 10,
      api_key: "$LINEAR_API_KEY",
    },
  }, path.join(process.cwd(), "WORKFLOW.md"), { LINEAR_API_KEY: "secret" });
  const client = new MockLinearClient([
    {
      data: {
        issues: {
          nodes: [linearIssue({ id: "issue-1", identifier: "ENG-1", title: "First", state: "Ready for AI" })],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    },
    {
      data: {
        issues: {
          nodes: [linearIssue({ id: "issue-2", identifier: "ENG-2", title: "Second", state: "Ready for AI" })],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ]);

  const tracker = new LinearTracker(config, client);
  const issues = await tracker.fetchCandidateIssues();

  assert.deepEqual(issues.map((issue) => issue.identifier), ["ENG-1", "ENG-2"]);
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0]!.query, /team: \{ key: \{ eq: \$teamKey \} \}/);
  assert.match(client.calls[0]!.query, /project: \{ slugId: \{ eq: \$projectSlug \} \}/);
  assert.match(client.calls[0]!.query, /labels: \{ name: \{ in: \$labelNames \} \}/);
  assert.deepEqual(client.calls[0]!.variables, {
    first: 2,
    after: null,
    stateNames: ["Ready for AI"],
    commentsFirst: 10,
    teamKey: "ENG",
    projectSlug: "ai-project",
    labelNames: ["codex"],
  });
  assert.equal(client.calls[1]!.variables.after, "cursor-1");
});

test("LinearTracker refreshes issue states by ids", async () => {
  const config = resolveConfig({
    tracker: {
      kind: "linear",
      team_key: "ENG",
      api_key: "$LINEAR_API_KEY",
    },
  }, path.join(process.cwd(), "WORKFLOW.md"), { LINEAR_API_KEY: "secret" });
  const client = new MockLinearClient([
    {
      data: {
        issues: {
          nodes: [linearIssue({ id: "issue-1", identifier: "ENG-1", title: "First", state: "Done" })],
        },
      },
    },
  ]);

  const tracker = new LinearTracker(config, client);
  const issues = await tracker.fetchIssueStatesByIds(["issue-1"]);

  assert.equal(issues[0]!.state, "Done");
  assert.deepEqual(client.calls[0]!.variables, { ids: ["issue-1"], first: 1, commentsFirst: 50 });
});

test("normalizeLinearIssue maps Linear payload into the internal Issue shape", () => {
  const issue = normalizeLinearIssue({
    id: "issue-1",
    identifier: "ENG-1",
    title: "Implement feature",
    description: "Details",
    priority: 2,
    branchName: "eng-1-feature",
    url: "https://linear.app/acme/issue/ENG-1",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-03T03:04:05.000Z",
    state: { name: "Ready for AI" },
    labels: { nodes: [{ name: "Codex" }, { name: "Backend" }] },
    comments: {
      nodes: [
        {
          id: "comment-1",
          body: `${SYMPHONY_RUN_REPORT_MARKER}\nSymphony run completed.`,
          createdAt: "2026-01-03T04:00:00.000Z",
          user: { displayName: "Symphony" },
        },
        {
          id: "comment-2",
          body: "Please mention draft PRs.",
          createdAt: "2026-01-03T05:00:00.000Z",
          user: { displayName: "Lucas" },
        },
        {
          id: "comment-3",
          body: `${SYMPHONY_PLAN_MARKER}\n1. Update config.\n2. Add tests.`,
          createdAt: "2026-01-03T06:00:00.000Z",
          user: { displayName: "Symphony" },
        },
        {
          id: "comment-4",
          body: "Keep the first version small.",
          createdAt: "2026-01-03T07:00:00.000Z",
          user: { displayName: "Lucas" },
        },
      ],
    },
    inverseRelations: {
      nodes: [
        {
          type: "blocks",
          issue: {
            id: "blocker-1",
            identifier: "ENG-0",
            state: { name: "In Progress" },
          },
        },
      ],
    },
  });

  assert.deepEqual(issue, {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Implement feature",
    description: "Details",
    priority: 2,
    state: "Ready for AI",
    branch_name: "eng-1-feature",
    url: "https://linear.app/acme/issue/ENG-1",
    labels: ["codex", "backend"],
    blocked_by: [{ id: "blocker-1", identifier: "ENG-0", state: "In Progress" }],
    comments: [
      {
        id: "comment-1",
        body: `${SYMPHONY_RUN_REPORT_MARKER}\nSymphony run completed.`,
        created_at: "2026-01-03T04:00:00.000Z",
        user_name: "Symphony",
      },
      {
        id: "comment-2",
        body: "Please mention draft PRs.",
        created_at: "2026-01-03T05:00:00.000Z",
        user_name: "Lucas",
      },
      {
        id: "comment-3",
        body: `${SYMPHONY_PLAN_MARKER}\n1. Update config.\n2. Add tests.`,
        created_at: "2026-01-03T06:00:00.000Z",
        user_name: "Symphony",
      },
      {
        id: "comment-4",
        body: "Keep the first version small.",
        created_at: "2026-01-03T07:00:00.000Z",
        user_name: "Lucas",
      },
    ],
    comments_summary: [
      `- 2026-01-03T04:00:00.000Z Symphony: ${SYMPHONY_RUN_REPORT_MARKER}\nSymphony run completed.`,
      "- 2026-01-03T05:00:00.000Z Lucas: Please mention draft PRs.",
      `- 2026-01-03T06:00:00.000Z Symphony: ${SYMPHONY_PLAN_MARKER}\n1. Update config.\n2. Add tests.`,
      "- 2026-01-03T07:00:00.000Z Lucas: Keep the first version small.",
    ].join("\n"),
    feedback_since_last_run: [
      {
        id: "comment-2",
        body: "Please mention draft PRs.",
        created_at: "2026-01-03T05:00:00.000Z",
        user_name: "Lucas",
      },
      {
        id: "comment-4",
        body: "Keep the first version small.",
        created_at: "2026-01-03T07:00:00.000Z",
        user_name: "Lucas",
      },
    ],
    feedback_since_last_run_summary: [
      "- 2026-01-03T05:00:00.000Z Lucas: Please mention draft PRs.",
      "- 2026-01-03T07:00:00.000Z Lucas: Keep the first version small.",
    ].join("\n"),
    latest_symphony_plan: "1. Update config.\n2. Add tests.",
    plan_feedback_since_latest_plan: [
      {
        id: "comment-4",
        body: "Keep the first version small.",
        created_at: "2026-01-03T07:00:00.000Z",
        user_name: "Lucas",
      },
    ],
    plan_feedback_since_latest_plan_summary: "- 2026-01-03T07:00:00.000Z Lucas: Keep the first version small.",
    symphony_planning_mode: false,
    symphony_implementation_mode: false,
    created_at: "2026-01-02T03:04:05.000Z",
    updated_at: "2026-01-03T03:04:05.000Z",
  });
});

test("feedbackSinceLatestPlan returns human comments after the latest Symphony plan marker", () => {
  const comments = [
    { id: "1", body: `${SYMPHONY_PLAN_MARKER}\nold plan`, created_at: "2026-01-01T00:00:00.000Z", user_name: "Symphony" },
    { id: "2", body: "old feedback", created_at: "2026-01-01T01:00:00.000Z", user_name: "Lucas" },
    { id: "3", body: `${SYMPHONY_PLAN_MARKER}\nnew plan`, created_at: "2026-01-01T02:00:00.000Z", user_name: "Symphony" },
    { id: "4", body: "approve with smaller scope", created_at: "2026-01-01T03:00:00.000Z", user_name: "Lucas" },
  ];

  assert.deepEqual(feedbackSinceLatestPlan(comments).map((comment) => comment.body), ["approve with smaller scope"]);
});

test("feedbackSinceLastRun returns only comments after the latest Symphony report marker", () => {
  const comments = [
    { id: "1", body: "old feedback", created_at: "2026-01-01T00:00:00.000Z", user_name: "Lucas" },
    { id: "2", body: `${SYMPHONY_RUN_REPORT_MARKER}\ncompleted`, created_at: "2026-01-01T01:00:00.000Z", user_name: "Symphony" },
    { id: "3", body: "first follow-up", created_at: "2026-01-01T02:00:00.000Z", user_name: "Lucas" },
    { id: "4", body: "second follow-up", created_at: "2026-01-01T03:00:00.000Z", user_name: "Lucas" },
  ];

  assert.deepEqual(feedbackSinceLastRun(comments).map((comment) => comment.body), ["first follow-up", "second follow-up"]);
});

function linearIssue(fields: { id: string; identifier: string; title: string; state: string }): JsonMap {
  return {
    id: fields.id,
    identifier: fields.identifier,
    title: fields.title,
    description: null,
    priority: 1,
    branchName: null,
    url: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: { name: fields.state },
    labels: { nodes: [{ name: "codex" }] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    comments: { nodes: [] },
  };
}
