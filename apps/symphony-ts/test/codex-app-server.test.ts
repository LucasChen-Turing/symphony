import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsoleLogger } from "../src/logger.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { WorkflowStore } from "../src/workflow-store.ts";

test("app_server protocol path starts a thread and completes a turn", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-app-server-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const fakeServer = path.resolve("test/fixtures/fake-app-server.sh");
  await fs.writeFile(workflowPath, `---
tracker:
  kind: mock
  active_states:
    - Todo
  issues:
    - id: issue-1
      identifier: APP-1
      title: App server test
      state: Todo
workspace:
  root: ./workspaces
agent:
  max_turns: 1
codex:
  protocol: app_server
  command: bash ${JSON.stringify(fakeServer)}
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: false
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false
  read_timeout_ms: 1000
  turn_timeout_ms: 5000
  stall_timeout_ms: 0
---
Run {{ issue.identifier }}
`, "utf8");

  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath), new ConsoleLogger(), {
    once: true,
    enableRetries: false,
  });
  await orchestrator.start();
  await orchestrator.waitForIdle(10000);

  assert.deepEqual(orchestrator.snapshot().completed, ["issue-1"]);
});
