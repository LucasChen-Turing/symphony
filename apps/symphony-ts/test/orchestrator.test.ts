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
