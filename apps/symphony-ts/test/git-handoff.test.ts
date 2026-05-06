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

test("git workspace reuses an existing remote issue branch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-reuse-"));
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
  const first = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
  await runChecked("git", ["config", "user.name", "Test User"], { cwd: first.runPath });
  await runChecked("git", ["config", "user.email", "test@example.test"], { cwd: first.runPath });
  await fs.writeFile(path.join(first.runPath, "remote-branch.txt"), "remote\n", "utf8");
  await runChecked("git", ["add", "remote-branch.txt"], { cwd: first.runPath });
  await runChecked("git", ["commit", "-m", "remote branch change"], { cwd: first.runPath });
  const remoteBranchSha = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: first.runPath })).stdout.trim();
  await runChecked("git", ["push", "-u", "origin", first.branchName!], { cwd: first.runPath });
  await runChecked("git", ["checkout", "main"], { cwd: first.runPath });

  const reused = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());

  const head = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: reused.runPath })).stdout.trim();
  assert.equal(head, remoteBranchSha);
  assert.equal(await fs.readFile(path.join(reused.runPath, "remote-branch.txt"), "utf8"), "remote\n");
});

test("handoff validates, commits, pushes, and creates a draft PR", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-handoff-"));
  const remote = await createRemoteRepo(dir);
  const binDir = path.join(dir, "bin");
  const ghLog = path.join(dir, "gh.log");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
if [[ "$1 $2" == "pr view" ]]; then
  exit 1
fi
printf 'https://github.com/acme/symphony/pull/1\\n'
`, { mode: 0o755 });

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
    const ghCalls = await fs.readFile(ghLog, "utf8");
    assert.match(ghCalls, /pr view symphony\/SYM-1-test-issue --state open/);
    assert.match(ghCalls, /pr create/);
    const remoteBranch = (await runChecked("git", ["--git-dir", remote, "rev-parse", "symphony/SYM-1-test-issue"], { cwd: dir })).stdout.trim();
    assert.equal(remoteBranch, result.commitSha);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("handoff reuses an existing PR for the issue branch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-handoff-pr-reuse-"));
  const remote = await createRemoteRepo(dir);
  const binDir = path.join(dir, "bin");
  const ghLog = path.join(dir, "gh.log");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
if [[ "$1 $2" == "pr view" ]]; then
  printf 'https://github.com/acme/symphony/pull/1\\n'
  exit 0
fi
printf 'unexpected gh call\\n' >&2
exit 1
`, { mode: 0o755 });

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
    await fs.writeFile(path.join(gitWorkspace.runPath, "followup.txt"), "done\n", "utf8");

    const result = await new HandoffManager(config, new ConsoleLogger()).complete(issue(), gitWorkspace);

    assert.equal(result.prUrl, "https://github.com/acme/symphony/pull/1");
    const ghCalls = await fs.readFile(ghLog, "utf8");
    assert.match(ghCalls, /pr view symphony\/SYM-1-test-issue --state open/);
    assert.doesNotMatch(ghCalls, /pr create/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("handoff creates a new draft PR when no open PR exists for the branch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-handoff-pr-closed-"));
  const remote = await createRemoteRepo(dir);
  const binDir = path.join(dir, "bin");
  const ghLog = path.join(dir, "gh.log");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
if [[ "$1 $2" == "pr view" ]]; then
  exit 1
fi
if [[ "$1 $2" == "pr create" ]]; then
  printf 'https://github.com/acme/symphony/pull/2\\n'
  exit 0
fi
printf 'unexpected gh call\\n' >&2
exit 1
`, { mode: 0o755 });

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
    await fs.writeFile(path.join(gitWorkspace.runPath, "new-pr.txt"), "done\n", "utf8");

    const result = await new HandoffManager(config, new ConsoleLogger()).complete(issue(), gitWorkspace);

    assert.equal(result.prUrl, "https://github.com/acme/symphony/pull/2");
    const ghCalls = await fs.readFile(ghLog, "utf8");
    assert.match(ghCalls, /pr view symphony\/SYM-1-test-issue --state open/);
    assert.match(ghCalls, /pr create/);
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
    comments: [],
    comments_summary: "",
    feedback_since_last_run: [],
    feedback_since_last_run_summary: "",
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}
