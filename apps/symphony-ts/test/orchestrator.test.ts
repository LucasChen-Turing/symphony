import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsoleLogger } from "../src/logger.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { sanitizeWorkspaceKey } from "../src/util.ts";
import { WorkflowStore } from "../src/workflow-store.ts";

test("single poll creates a workspace, runs configured command, and records completion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-run-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const workspaceRoot = path.join(dir, "workspaces");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
  terminal_states:
    - Done
  issues:
    - id: issue-1
      identifier: TST/1
      title: Run the command
      description: Verify orchestration
      priority: 1
      state: Todo
workspace:
  root: ./workspaces
agent:
  max_concurrent_agents: 1
codex:
  command: printf agent-ran
  turn_timeout_ms: 10000
  stall_timeout_ms: 0
---
Issue {{ issue.identifier }}: {{ issue.title }}
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(10000);

  const snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running, []);
  assert.deepEqual(snapshot.completed, ["issue-1"]);

  const workspace = path.join(workspaceRoot, sanitizeWorkspaceKey("TST/1"));
  const stat = await fs.stat(workspace);
  assert.equal(stat.isDirectory(), true);
  const logs = await fs.readdir(path.join(workspace, ".symphony", "logs"));
  assert.equal(logs.length, 1);
  const log = await fs.readFile(path.join(workspace, ".symphony", "logs", logs[0]!), "utf8");
  assert.match(log, /agent-ran/);
  const prompt = await fs.readFile(path.join(workspace, ".symphony", "prompt.md"), "utf8");
  assert.match(prompt, /Issue TST\/1: Run the command/);
});

test("blocked Todo issues are not dispatched", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-blocked-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
  terminal_states:
    - Done
  issues:
    - id: issue-1
      identifier: TST-1
      title: Blocked
      state: Todo
      blocked_by:
        - id: blocker
          identifier: TST-0
          state: Todo
workspace:
  root: ./workspaces
codex:
  command: node -e "process.exit(0)"
  stall_timeout_ms: 0
---
Prompt
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(1000);
  assert.deepEqual(orchestrator.snapshot().completed, []);
});

test("planning state dispatches in planning mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-run-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const workspaceRoot = path.join(dir, "workspaces");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
  issues:
    - id: issue-1
      identifier: TST-PLAN
      title: Plan first
      state: Todo
workspace:
  root: ./workspaces
linear:
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
codex:
  command: printf '1. Inspect code\\n2. Add tests\\n'
  stall_timeout_ms: 0
---
{% if issue.symphony_planning_mode %}Planning only for {{ issue.identifier }}{% endif %}
{% if issue.symphony_implementation_mode %}Implementation for {{ issue.identifier }}{% endif %}
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(10000);

  assert.deepEqual(orchestrator.snapshot().completed, ["issue-1"]);
  const workspace = path.join(workspaceRoot, sanitizeWorkspaceKey("TST-PLAN"));
  const prompt = await fs.readFile(path.join(workspace, ".symphony", "prompt.md"), "utf8");
  assert.match(prompt, /Planning only for TST-PLAN/);
  assert.doesNotMatch(prompt, /Implementation for TST-PLAN/);
});

test("Plan Review issues are not dispatched", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-review-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
    - Plan Review
    - In Progress
  issues:
    - id: issue-1
      identifier: TST-REVIEW
      title: Awaiting approval
      state: Plan Review
workspace:
  root: ./workspaces
linear:
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
codex:
  command: node -e "process.exit(0)"
  stall_timeout_ms: 0
---
Prompt
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(1000);
  assert.deepEqual(orchestrator.snapshot().completed, []);
});

test("Plan Review change feedback regenerates a plan without implementation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-review-change-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const workspaceRoot = path.join(dir, "workspaces");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
    - In Progress
  issues:
    - id: issue-1
      identifier: TST-REPLAN
      title: Rework the plan
      state: Plan Review
      latest_symphony_plan: "1. Old plan"
      plan_feedback_since_latest_plan:
        - body: "Please update the plan to add tests first."
          user_name: "Reviewer"
      plan_feedback_since_latest_plan_summary: "- Reviewer: Please update the plan to add tests first."
workspace:
  root: ./workspaces
linear:
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
codex:
  command: printf '1. Add tests first\\n2. Update implementation\\n'
  stall_timeout_ms: 0
---
{% if issue.symphony_planning_mode %}Planning {{ issue.identifier }} with {{ issue.plan_feedback_since_latest_plan_summary }}{% endif %}
{% if issue.symphony_implementation_mode %}Implementation {{ issue.identifier }}{% endif %}
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(10000);

  assert.deepEqual(orchestrator.snapshot().completed, ["issue-1"]);
  const workspace = path.join(workspaceRoot, sanitizeWorkspaceKey("TST-REPLAN"));
  const prompt = await fs.readFile(path.join(workspace, ".symphony", "prompt.md"), "utf8");
  assert.match(prompt, /Planning TST-REPLAN/);
  assert.match(prompt, /add tests first/);
  assert.doesNotMatch(prompt, /Implementation TST-REPLAN/);
});

test("Plan Review approval feedback does not dispatch implementation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-review-approve-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const workspaceRoot = path.join(dir, "workspaces");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
    - In Progress
  issues:
    - id: issue-1
      identifier: TST-APPROVE
      title: Approved plan
      state: Plan Review
      latest_symphony_plan: "1. Current plan"
      plan_feedback_since_latest_plan:
        - body: "LGTM"
          user_name: "Reviewer"
workspace:
  root: ./workspaces
linear:
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
codex:
  command: node -e "process.exit(2)"
  stall_timeout_ms: 0
---
Implementation {{ issue.identifier }}
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(1000);

  assert.deepEqual(orchestrator.snapshot().completed, []);
  await assert.rejects(fs.stat(path.join(workspaceRoot, sanitizeWorkspaceKey("TST-APPROVE"))));
});

test("Plan Review unclear feedback stays idle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-review-idle-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const workspaceRoot = path.join(dir, "workspaces");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
    - In Progress
  issues:
    - id: issue-1
      identifier: TST-IDLE
      title: Unclear feedback
      state: Plan Review
      latest_symphony_plan: "1. Current plan"
      plan_feedback_since_latest_plan:
        - body: "I will think about this."
          user_name: "Reviewer"
workspace:
  root: ./workspaces
linear:
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
codex:
  command: node -e "process.exit(2)"
  stall_timeout_ms: 0
---
Prompt
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(1000);

  assert.deepEqual(orchestrator.snapshot().completed, []);
  await assert.rejects(fs.stat(path.join(workspaceRoot, sanitizeWorkspaceKey("TST-IDLE"))));
});

test("Plan Review blocking phrases prevent approval promotion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-plan-review-blocked-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const workspaceRoot = path.join(dir, "workspaces");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
    - In Progress
  issues:
    - id: issue-1
      identifier: TST-BLOCKED
      title: Blocked approval
      state: Plan Review
      latest_symphony_plan: "1. Current plan"
      plan_feedback_since_latest_plan:
        - body: "LGTM but hold for now."
          user_name: "Reviewer"
workspace:
  root: ./workspaces
linear:
  planning_state: Todo
  plan_review_status: Plan Review
  implementation_state: In Progress
codex:
  command: node -e "process.exit(2)"
  stall_timeout_ms: 0
---
Prompt
`);

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(1000);

  assert.deepEqual(orchestrator.snapshot().completed, []);
  await assert.rejects(fs.stat(path.join(workspaceRoot, sanitizeWorkspaceKey("TST-BLOCKED"))));
});
