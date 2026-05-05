import fs from "node:fs/promises";
import path from "node:path";
import type { EffectiveConfig, GitWorkspace, Issue, Logger } from "./types.ts";
import { isPathInside, sanitizeWorkspaceKey } from "./util.ts";
import { runChecked, runProcess } from "./process-runner.ts";

export class GitWorkspaceManager {
  private readonly config: EffectiveConfig;
  private readonly logger: Logger;

  constructor(config: EffectiveConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async prepare(workspacePath: string, issue: Issue): Promise<GitWorkspace> {
    if (!this.config.git.enabled) {
      return {
        workspacePath,
        runPath: workspacePath,
        branchName: null,
        repoUrl: null,
      };
    }

    const repo = this.requireAllowedRepo();
    const repoPath = path.resolve(workspacePath, this.config.git.directory);
    if (!isPathInside(workspacePath, repoPath)) {
      throw new Error(`git repo path escaped workspace: ${repoPath}`);
    }

    await this.ensureRepo(workspacePath, repoPath, repo);
    await this.ensureLocalExcludes(repoPath);
    const branchName = buildBranchName(this.config.git.branchPrefix, issue);
    await this.checkoutBranch(repoPath, branchName);

    return {
      workspacePath,
      runPath: repoPath,
      branchName,
      repoUrl: repo,
    };
  }

  private requireAllowedRepo(): string {
    const repo = this.config.git.repo;
    if (!repo) {
      throw new Error("missing_git_repo");
    }
    if (this.config.git.allowedRepos.length > 0 && !this.config.git.allowedRepos.includes(repo)) {
      throw new Error("git_repo_not_allowed");
    }
    return repo;
  }

  private async ensureRepo(workspacePath: string, repoPath: string, repo: string): Promise<void> {
    const gitDir = path.join(repoPath, ".git");
    try {
      const stat = await fs.stat(gitDir);
      if (!stat.isDirectory()) {
        throw new Error(`${gitDir} exists but is not a directory`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    this.logger.info("git clone started", { repo, cwd: workspacePath });
    await runChecked("git", ["clone", "--", repo, repoPath], { cwd: workspacePath, timeoutMs: 300000 });
    this.logger.info("git clone completed", { repo, cwd: repoPath });
  }

  private async ensureLocalExcludes(repoPath: string): Promise<void> {
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    let current = "";
    try {
      current = await fs.readFile(excludePath, "utf8");
    } catch {
      return;
    }
    if (!current.split(/\r?\n/).includes(".symphony/")) {
      await fs.appendFile(excludePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.symphony/\n`, "utf8");
    }
  }

  private async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
    const base = this.config.git.baseBranch;
    const remote = this.config.github.remote;

    if (branchName === base || branchName === "main" || branchName === "master") {
      throw new Error(`refusing to use protected branch name: ${branchName}`);
    }

    const remoteBranchRef = `${remote}/${branchName}`;
    if (await this.fetchRemoteBranch(repoPath, remote, branchName)) {
      await runChecked("git", ["checkout", "-B", branchName, remoteBranchRef], { cwd: repoPath, timeoutMs: 120000 });
      this.logger.info("git branch prepared from existing remote branch", {
        cwd: repoPath,
        branch: branchName,
        remote_branch: remoteBranchRef,
      });
      return;
    }

    let baseRef = `${remote}/${base}`;
    try {
      await runChecked("git", ["fetch", remote, base], { cwd: repoPath, timeoutMs: 300000 });
    } catch (error) {
      this.logger.warn("git fetch failed; falling back to local base branch", {
        cwd: repoPath,
        base_branch: base,
        error: error instanceof Error ? error.message : String(error),
      });
      baseRef = base;
    }

    await runChecked("git", ["checkout", "-B", branchName, baseRef], { cwd: repoPath, timeoutMs: 120000 });
    this.logger.info("git branch prepared from base branch", { cwd: repoPath, branch: branchName, base: baseRef });
  }

  private async fetchRemoteBranch(repoPath: string, remote: string, branchName: string): Promise<boolean> {
    const result = await runProcess("git", [
      "fetch",
      remote,
      `refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`,
    ], { cwd: repoPath, timeoutMs: 300000 });
    return result.code === 0;
  }
}

export function buildBranchName(prefix: string, issue: Issue): string {
  const safePrefix = sanitizeBranchPart(prefix).replace(/^\/+|\/+$/g, "") || "symphony";
  const titleSlug = sanitizeBranchPart(issue.title)
    .toLowerCase()
    .replace(/[._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const issuePart = sanitizeWorkspaceKey(issue.identifier);
  return `${safePrefix}/${issuePart}${titleSlug ? `-${titleSlug}` : ""}`.slice(0, 100);
}

function sanitizeBranchPart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/\.\./g, ".")
    .replace(/-+/g, "-");
}
