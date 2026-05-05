import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConsoleLogger } from "../src/logger.ts";
import { resolveConfig } from "../src/config.ts";
import { GitWorkspaceManager, buildBranchName } from "../src/git-workspace.ts";
import { HandoffManager } from "../src/handoff.ts";
import { WorkspaceManager } from "../src/workspace.ts";
import { runChecked } from "../src/process-runner.ts";
import type { Issue } from "../src/types.ts";

test("buildBranchName creates a protected-prefix issue branch", () => {
  assert.equal(buildBranchName("symphony", issue({ identifier: "SYM/7", title: "Add PR handoff!" })), "symphony/SYM_7-add-pr-handoff");
});

test("git workspace clones an allowed repo and checks out an issue branch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-"));
  const remote = await createRemoteRepo(dir);
  const config = resolveConfig({
    tracker: { kind: "mock" },
    workspace: { root: path.join(dir, "workspaces") },
    git: {
      enabled: true,
      repo: remote,
      allowed_repos: [remote],
      base_branch: "main",
      branch_prefix: "symphony",
    },
  }, path.join(dir, "WORKFLOW.md"));

  const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-1");
  const gitWorkspace = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());

  assert.equal(gitWorkspace.branchName, "symphony/SYM-1-test-issue");
  assert.equal(gitWorkspace.runPath, path.join(workspace.path, "repo"));
  const branch = (await runChecked("git", ["branch", "--show-current"], { cwd: gitWorkspace.runPath })).stdout.trim();
  assert.equal(branch, "symphony/SYM-1-test-issue");
});

test("handoff validates, commits, pushes, and creates a draft PR", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-handoff-"));
  const remote = await createRemoteRepo(dir);
  const binDir = path.join(dir, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gh"), "#!/usr/bin/env bash\nprintf 'https://github.com/acme/symphony/pull/1\\n'\n", { mode: 0o755 });

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  try {
    const config = resolveConfig({
      tracker: { kind: "mock" },
      workspace: { root: path.join(dir, "workspaces") },
      git: {
        enabled: true,
        repo: remote,
        allowed_repos: [remote],
        base_branch: "main",
        branch_prefix: "symphony",
        validation_command: "test -f README.md",
        commit_author_name: "Symphony",
        commit_author_email: "symphony@example.test",
      },
      github: {
        create_pr: true,
        draft: true,
      },
    }, path.join(dir, "WORKFLOW.md"));

    const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-1");
    const gitWorkspace = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
    await fs.writeFile(path.join(gitWorkspace.runPath, "feature.txt"), "done\n", "utf8");

    const result = await new HandoffManager(config, new ConsoleLogger()).complete(issue(), gitWorkspace);

    assert.equal(result.changed, true);
    assert.equal(result.branchName, "symphony/SYM-1-test-issue");
    assert.equal(result.prUrl, "https://github.com/acme/symphony/pull/1");
    assert.match(result.commitSha ?? "", /^[0-9a-f]{40}$/);
    const remoteBranch = (await runChecked("git", ["--git-dir", remote, "rev-parse", "symphony/SYM-1-test-issue"], { cwd: dir })).stdout.trim();
    assert.equal(remoteBranch, result.commitSha);
  } finally {
    process.env.PATH = oldPath;
  }
});

async function createRemoteRepo(dir: string): Promise<string> {
  const seed = path.join(dir, "seed");
  const remote = path.join(dir, "origin.git");
  await fs.mkdir(seed);
  await runChecked("git", ["init"], { cwd: seed });
  await runChecked("git", ["checkout", "-B", "main"], { cwd: seed });
  await runChecked("git", ["config", "user.name", "Test User"], { cwd: seed });
  await runChecked("git", ["config", "user.email", "test@example.test"], { cwd: seed });
  await fs.writeFile(path.join(seed, "README.md"), "seed\n", "utf8");
  await runChecked("git", ["add", "README.md"], { cwd: seed });
  await runChecked("git", ["commit", "-m", "seed"], { cwd: seed });
  await runChecked("git", ["clone", "--bare", seed, remote], { cwd: dir });
  return remote;
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: "https://linear.app/acme/issue/SYM-1",
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}
