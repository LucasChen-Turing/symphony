import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseWorkflow } from "../src/workflow.ts";
import { resolveConfig, validateForDispatch } from "../src/config.ts";
import { renderPrompt } from "../src/prompt.ts";
import type { Issue } from "../src/types.ts";

test("parses YAML front matter and Markdown prompt body", () => {
  const workflow = parseWorkflow(`---
tracker:
  kind: mock
  active_states:
    - Todo
hooks:
  after_create: |
    echo created
---

Hello {{ issue.identifier }}
`);

  assert.equal(workflow.prompt_template, "Hello {{ issue.identifier }}");
  assert.deepEqual(workflow.config.tracker, { kind: "mock", active_states: ["Todo"] });
  assert.equal((workflow.config.hooks as Record<string, string>).after_create, "echo created");
});

test("resolves config defaults, env indirection, and workspace path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-config-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const config = resolveConfig({
    tracker: {
      kind: "linear",
      project_slug: "project",
      api_key: "$TEST_LINEAR_KEY",
    },
    workspace: {
      root: "./workspaces",
    },
  }, workflowPath, { TEST_LINEAR_KEY: "secret" });

  assert.equal(config.tracker.apiKey, "secret");
  assert.equal(config.tracker.projectSlug, "project");
  assert.equal(config.tracker.endpoint, "https://api.linear.app/graphql");
  assert.equal(config.polling.intervalMs, 30000);
  assert.equal(config.workspace.root, path.join(dir, "workspaces"));
  validateForDispatch(config);
});

test("resolves Linear read-only extension config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-linear-config-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const config = resolveConfig({
    tracker: {
      kind: "linear",
      team_key: "ENG",
      statuses: ["Ready for AI"],
      labels: ["codex"],
      limit: 7,
    },
  }, workflowPath, { LINEAR_API_KEY: "linear-secret" });

  assert.equal(config.tracker.apiKey, "linear-secret");
  assert.equal(config.tracker.teamKey, "ENG");
  assert.deepEqual(config.tracker.activeStates, ["Ready for AI"]);
  assert.deepEqual(config.tracker.labels, ["codex"]);
  assert.equal(config.tracker.limit, 7);
  validateForDispatch(config);
});

test("resolves Linear planning gate config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-config-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const config = resolveConfig({
    tracker: {
      kind: "linear",
      team_key: "SYM",
      active_states: ["Todo", "In Progress"],
    },
    linear: {
      planning_state: "Todo",
      plan_review_status: "Plan Review",
      implementation_state: "In Progress",
    },
  }, workflowPath, { LINEAR_API_KEY: "linear-secret" });

  assert.equal(config.linear.planningState, "Todo");
  assert.equal(config.linear.planReviewStatus, "Plan Review");
  assert.equal(config.linear.implementationState, "In Progress");
  validateForDispatch(config);
});

test("renderPrompt can include approved plan context for implementation mode", () => {
  const rendered = renderPrompt(`{% if issue.symphony_implementation_mode %}Plan:
{{ issue.latest_symphony_plan }}
Feedback:
{{ issue.plan_feedback_since_latest_plan_summary }}{% endif %}`, {
    ...sampleIssue(),
    state: "In Progress",
    latest_symphony_plan: "1. Touch config\n2. Add tests",
    plan_feedback_since_latest_plan_summary: "- 2026-05-06 Reviewer: Keep it small.",
    symphony_implementation_mode: true,
  }, null);

  assert.match(rendered, /Touch config/);
  assert.match(rendered, /Keep it small/);
});

test("renderPrompt fails on unknown variables", () => {
  assert.throws(
    () => renderPrompt("Hello {{ issue.nope }}", sampleIssue(), null),
    /Unknown variable/,
  );
});

test("renderPrompt handles interpolation and if/else blocks", () => {
  const rendered = renderPrompt("{% if attempt %}Retry {{ attempt }}{% else %}First {{ issue.identifier }}{% endif %}", sampleIssue(), null);
  assert.equal(rendered, "First TST-1");

  const retry = renderPrompt("{% if attempt %}Retry {{ attempt }}{% else %}First{% endif %}", sampleIssue(), 2);
  assert.equal(retry, "Retry 2");
});

function sampleIssue(): Issue {
  return {
    id: "issue-1",
    identifier: "TST-1",
    title: "Test issue",
    description: "Description",
    priority: 1,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: ["test"],
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
