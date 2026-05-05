import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { LinearWriteback } from "../src/linear-writeback.ts";
import { ConsoleLogger } from "../src/logger.ts";
import type { Issue, JsonMap } from "../src/types.ts";

class MockLinearClient {
  calls: Array<{ query: string; variables: JsonMap }> = [];
  responses: Array<{ data: JsonMap }> = [
    { data: { commentCreate: { success: true, comment: { id: "comment-1" } } } },
    { data: { workflowStates: { nodes: [{ id: "state-review", name: "AI Needs Review" }] } } },
    { data: { issueUpdate: { success: true, issue: { id: "issue-1", identifier: "SYM-1" } } } },
  ];

  async query(query: string, variables: JsonMap): Promise<{ data: JsonMap }> {
    this.calls.push({ query, variables });
    const response = this.responses.shift();
    if (!response) throw new Error("missing mock response");
    return response;
  }
}

test("LinearWriteback comments and moves the issue to review status", async () => {
  const config = resolveConfig({
    tracker: {
      kind: "linear",
      team_key: "SYM",
      api_key: "$LINEAR_API_KEY",
    },
    linear: {
      writeback: true,
      review_status: "AI Needs Review",
    },
  }, path.join(process.cwd(), "WORKFLOW.md"), { LINEAR_API_KEY: "secret" });
  const client = new MockLinearClient();

  await new LinearWriteback(config, new ConsoleLogger(), client).markReview(issue(), "done");

  assert.equal(client.calls.length, 3);
  assert.match(client.calls[0]!.query, /commentCreate/);
  assert.deepEqual(client.calls[0]!.variables, { issueId: "issue-1", body: "done" });
  assert.match(client.calls[1]!.query, /workflowStates/);
  assert.deepEqual(client.calls[1]!.variables, { teamKey: "SYM", statusName: "AI Needs Review" });
  assert.match(client.calls[2]!.query, /issueUpdate/);
  assert.deepEqual(client.calls[2]!.variables, { issueId: "issue-1", stateId: "state-review" });
});

function issue(): Issue {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}
