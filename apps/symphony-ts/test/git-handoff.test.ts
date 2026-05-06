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
  assert.equal(gitWorkspace.prBaseBranch, "main");
  assert.equal(gitWorkspace.runPath, path.join(workspace.path, "repo"));
  const branch = (await runChecked("git", ["branch", "--show-current"], { cwd: gitWorkspace.runPath })).stdout.trim();
  assert.equal(branch, "symphony/SYM-1-test-issue");
});

test("normal issue still uses git base branch when sub-issue base is enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-normal-base-"));
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
      subissue_base: "parent_issue_branch",
    },
  }, path.join(dir, "WORKFLOW.md"));

  await commitFileToRemote(dir, remote, "main", "base.txt", "main\n", "main branch change");
  const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-2");
  const gitWorkspace = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue({ identifier: "SYM-2" }));

  assert.equal(gitWorkspace.prBaseBranch, "main");
  assert.equal(await fs.readFile(path.join(gitWorkspace.runPath, "base.txt"), "utf8"), "main\n");
});

test("sub-issue uses parent issue branch when found", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-parent-base-"));
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
      subissue_base: "parent_issue_branch",
    },
  }, path.join(dir, "WORKFLOW.md"));

  const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-13");
  const manager = new GitWorkspaceManager(config, new ConsoleLogger());
  const parent = await manager.prepare(workspace.path, issue({ identifier: "SYM-12", title: "Parent issue" }));
  await runChecked("git", ["config", "user.name", "Test User"], { cwd: parent.runPath });
  await runChecked("git", ["config", "user.email", "test@example.test"], { cwd: parent.runPath });
  await fs.writeFile(path.join(parent.runPath, "parent.txt"), "parent\n", "utf8");
  await runChecked("git", ["add", "parent.txt"], { cwd: parent.runPath });
  await runChecked("git", ["commit", "-m", "parent branch change"], { cwd: parent.runPath });
  const parentHead = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: parent.runPath })).stdout.trim();
  await runChecked("git", ["push", "-u", "origin", parent.branchName!], { cwd: parent.runPath });

  const child = await manager.prepare(workspace.path, issue({
    identifier: "SYM-13",
    title: "Child issue",
    parent: { id: "issue-12", identifier: "SYM-12", title: "Parent issue" },
  }));

  const childHead = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: child.runPath })).stdout.trim();
  assert.equal(child.prBaseBranch, "symphony/SYM-12-parent-issue");
  assert.equal(childHead, parentHead);
  assert.equal(await fs.readFile(path.join(child.runPath, "parent.txt"), "utf8"), "parent\n");
});

test("sub-issue falls back to git base branch when parent branch is missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-parent-missing-"));
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
      subissue_base: "parent_issue_branch",
    },
  }, path.join(dir, "WORKFLOW.md"));

  await commitFileToRemote(dir, remote, "main", "base.txt", "main\n", "main branch change");
  const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-13");
  const child = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue({
    identifier: "SYM-13",
    title: "Child issue",
    parent: { id: "issue-12", identifier: "SYM-12", title: "Parent issue" },
  }));

  assert.equal(child.prBaseBranch, "main");
  assert.equal(await fs.readFile(path.join(child.runPath, "base.txt"), "utf8"), "main\n");
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

test("existing issue branch syncs with origin base before validation and handoff", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-sync-"));
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
      validation_command: "test -f base.txt",
      commit_author_name: "Symphony",
      commit_author_email: "symphony@example.test",
    },
  }, path.join(dir, "WORKFLOW.md"));

  const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-1");
  const first = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
  await fs.writeFile(path.join(first.runPath, "issue.txt"), "issue\n", "utf8");
  await runChecked("git", ["add", "issue.txt"], { cwd: first.runPath });
  await runChecked("git", ["commit", "-m", "issue branch change"], { cwd: first.runPath });
  await runChecked("git", ["push", "-u", "origin", first.branchName!], { cwd: first.runPath });
  await runChecked("git", ["checkout", "main"], { cwd: first.runPath });
  await commitFileToRemote(dir, remote, "main", "base.txt", "base\n", "base branch change");

  const reused = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
  await fs.writeFile(path.join(reused.runPath, "feature.txt"), "done\n", "utf8");
  const result = await new HandoffManager(config, new ConsoleLogger()).complete(issue(), reused);

  assert.equal(await fs.readFile(path.join(reused.runPath, "base.txt"), "utf8"), "base\n");
  assert.equal(await fs.readFile(path.join(reused.runPath, "issue.txt"), "utf8"), "issue\n");
  assert.equal(result.changed, true);
  assert.match(result.commitSha ?? "", /^[0-9a-f]{40}$/);
});

test("handoff pushes a clean issue branch that is ahead of its remote", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-handoff-ahead-"));
  const remote = await createRemoteRepo(dir);
  const validationLog = path.join(dir, "validation.log");
  const binDir = path.join(dir, "bin");
  const ghLog = path.join(dir, "gh.log");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
if [[ "$1 $2" == "pr view" ]]; then
  exit 1
fi
if [[ "$1 $2" == "pr create" ]]; then
  printf 'https://github.com/acme/symphony/pull/3\\n'
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
        validation_command: `test -f base.txt && printf validated > ${JSON.stringify(validationLog)}`,
        commit_author_name: "Symphony",
        commit_author_email: "symphony@example.test",
      },
      github: {
        create_pr: true,
        draft: true,
      },
    }, path.join(dir, "WORKFLOW.md"));

    const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-1");
    const first = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
    await fs.writeFile(path.join(first.runPath, "issue.txt"), "issue\n", "utf8");
    await runChecked("git", ["add", "issue.txt"], { cwd: first.runPath });
    await runChecked("git", ["commit", "-m", "issue branch change"], { cwd: first.runPath });
    await runChecked("git", ["push", "-u", "origin", first.branchName!], { cwd: first.runPath });
    await runChecked("git", ["checkout", "main"], { cwd: first.runPath });
    await commitFileToRemote(dir, remote, "main", "base.txt", "base\n", "base branch change");

    const reused = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
    const statusBefore = (await runChecked("git", ["status", "--porcelain"], { cwd: reused.runPath })).stdout.trim();
    const headBefore = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: reused.runPath })).stdout.trim();

    const result = await new HandoffManager(config, new ConsoleLogger()).complete(issue(), reused);

    assert.equal(statusBefore, "");
    assert.equal(result.changed, true);
    assert.equal(result.commitSha, headBefore);
    assert.equal(result.prUrl, "https://github.com/acme/symphony/pull/3");
    assert.equal(await fs.readFile(validationLog, "utf8"), "validated");
    const ghCalls = await fs.readFile(ghLog, "utf8");
    assert.match(ghCalls, /pr view symphony\/SYM-1-test-issue --state open/);
    assert.match(ghCalls, /pr create/);
    const remoteBranch = (await runChecked("git", ["--git-dir", remote, "rev-parse", "symphony/SYM-1-test-issue"], { cwd: dir })).stdout.trim();
    assert.equal(remoteBranch, headBefore);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("existing issue branch base sync failure is surfaced clearly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-git-sync-conflict-"));
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
      commit_author_name: "Symphony",
      commit_author_email: "symphony@example.test",
    },
  }, path.join(dir, "WORKFLOW.md"));

  const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-1");
  const first = await new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue());
  await fs.writeFile(path.join(first.runPath, "README.md"), "issue\n", "utf8");
  await runChecked("git", ["add", "README.md"], { cwd: first.runPath });
  await runChecked("git", ["commit", "-m", "issue readme change"], { cwd: first.runPath });
  const issueHead = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: first.runPath })).stdout.trim();
  await runChecked("git", ["push", "-u", "origin", first.branchName!], { cwd: first.runPath });
  await runChecked("git", ["checkout", "main"], { cwd: first.runPath });
  await commitFileToRemote(dir, remote, "main", "README.md", "base\n", "conflicting base change");

  await assert.rejects(
    () => new GitWorkspaceManager(config, new ConsoleLogger()).prepare(workspace.path, issue()),
    /git base branch sync failed: merge origin\/main into symphony\/SYM-1-test-issue failed code=1/,
  );
  const status = (await runChecked("git", ["status", "--porcelain"], { cwd: first.runPath })).stdout.trim();
  const head = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: first.runPath })).stdout.trim();
  assert.equal(status, "");
  assert.equal(head, issueHead);
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

test("handoff creates stacked PR against parent issue branch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-handoff-stacked-"));
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
  printf 'https://github.com/acme/symphony/pull/13\\n'
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
        subissue_base: "parent_issue_branch",
        commit_author_name: "Symphony",
        commit_author_email: "symphony@example.test",
      },
      github: {
        create_pr: true,
        draft: true,
      },
    }, path.join(dir, "WORKFLOW.md"));

    const workspace = await new WorkspaceManager(config, new ConsoleLogger()).ensureWorkspace("SYM-13");
    const manager = new GitWorkspaceManager(config, new ConsoleLogger());
    const parent = await manager.prepare(workspace.path, issue({ identifier: "SYM-12", title: "Parent issue" }));
    await runChecked("git", ["config", "user.name", "Test User"], { cwd: parent.runPath });
    await runChecked("git", ["config", "user.email", "test@example.test"], { cwd: parent.runPath });
    await fs.writeFile(path.join(parent.runPath, "parent.txt"), "parent\n", "utf8");
    await runChecked("git", ["add", "parent.txt"], { cwd: parent.runPath });
    await runChecked("git", ["commit", "-m", "parent branch change"], { cwd: parent.runPath });
    await runChecked("git", ["push", "-u", "origin", parent.branchName!], { cwd: parent.runPath });

    const childIssue = issue({
      identifier: "SYM-13",
      title: "Child issue",
      parent: { id: "issue-12", identifier: "SYM-12", title: "Parent issue" },
    });
    const child = await manager.prepare(workspace.path, childIssue);
    await fs.writeFile(path.join(child.runPath, "child.txt"), "child\n", "utf8");

    const result = await new HandoffManager(config, new ConsoleLogger()).complete(childIssue, child);

    assert.equal(result.prUrl, "https://github.com/acme/symphony/pull/13");
    const ghCalls = await fs.readFile(ghLog, "utf8");
    assert.match(ghCalls, /pr create/);
    assert.match(ghCalls, /--base symphony\/SYM-12-parent-issue --head symphony\/SYM-13-child-issue/);
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

async function commitFileToRemote(
  dir: string,
  remote: string,
  branch: string,
  file: string,
  contents: string,
  message: string,
): Promise<void> {
  const checkout = await fs.mkdtemp(path.join(dir, "remote-work-"));
  await runChecked("git", ["clone", remote, checkout], { cwd: dir });
  await runChecked("git", ["checkout", branch], { cwd: checkout });
  await runChecked("git", ["config", "user.name", "Test User"], { cwd: checkout });
  await runChecked("git", ["config", "user.email", "test@example.test"], { cwd: checkout });
  await fs.writeFile(path.join(checkout, file), contents, "utf8");
  await runChecked("git", ["add", file], { cwd: checkout });
  await runChecked("git", ["commit", "-m", message], { cwd: checkout });
  await runChecked("git", ["push", "origin", branch], { cwd: checkout });
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
    parent: null,
    url: "https://linear.app/acme/issue/SYM-1",
    labels: [],
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
    ...overrides,
  };
}
