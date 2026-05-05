import type { EffectiveConfig, GitWorkspace, HandoffResult, Issue, Logger } from "./types.ts";
import { runChecked, runProcess, runShell } from "./process-runner.ts";

export class HandoffManager {
  private readonly config: EffectiveConfig;
  private readonly logger: Logger;

  constructor(config: EffectiveConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async complete(issue: Issue, workspace: GitWorkspace): Promise<HandoffResult> {
    if (!this.config.git.enabled) {
      return { changed: false, branchName: null, commitSha: null, prUrl: null, validationOutput: null };
    }

    const changedBeforeValidation = await hasWorkingTreeChanges(workspace.runPath);
    if (!changedBeforeValidation) {
      this.logger.info("handoff skipped; no git changes", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      return { changed: false, branchName: workspace.branchName, commitSha: null, prUrl: null, validationOutput: null };
    }

    let validationOutput: string | null = null;
    if (this.config.git.validationCommand) {
      const validation = await runShell(this.config.git.validationCommand, {
        cwd: workspace.runPath,
        timeoutMs: this.config.codex.turnTimeoutMs,
      });
      validationOutput = (validation.stdout + validation.stderr).trim().slice(0, 4000) || null;
      if (validation.code !== 0) {
        throw new Error(`validation failed code=${validation.code}: ${validationOutput ?? ""}`);
      }
      this.logger.info("validation command completed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        command: this.config.git.validationCommand,
      });
    }

    const changed = await hasWorkingTreeChanges(workspace.runPath);
    if (!changed) {
      this.logger.info("handoff skipped; no git changes", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      return { changed: false, branchName: workspace.branchName, commitSha: null, prUrl: null, validationOutput };
    }

    await runChecked("git", ["add", "-A"], { cwd: workspace.runPath, timeoutMs: 120000 });
    const stagedDiff = await runProcess("git", ["diff", "--cached", "--quiet"], { cwd: workspace.runPath, timeoutMs: 120000 });
    if (stagedDiff.code === 0) {
      return { changed: false, branchName: workspace.branchName, commitSha: null, prUrl: null, validationOutput };
    }

    await this.commit(issue, workspace.runPath);
    const commitSha = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: workspace.runPath, timeoutMs: 30000 })).stdout.trim();
    let prUrl: string | null = null;

    if (this.config.github.createPr) {
      if (!workspace.branchName) {
        throw new Error("github.create_pr requires a git branch");
      }
      await runChecked("git", ["push", "-u", this.config.github.remote, workspace.branchName], {
        cwd: workspace.runPath,
        timeoutMs: 300000,
      });
      prUrl = await this.createDraftPr(issue, workspace);
    }

    return { changed: true, branchName: workspace.branchName, commitSha, prUrl, validationOutput };
  }

  private async commit(issue: Issue, cwd: string): Promise<void> {
    const env = { ...process.env };
    if (this.config.git.commitAuthorName) {
      env.GIT_AUTHOR_NAME = this.config.git.commitAuthorName;
      env.GIT_COMMITTER_NAME = this.config.git.commitAuthorName;
    }
    if (this.config.git.commitAuthorEmail) {
      env.GIT_AUTHOR_EMAIL = this.config.git.commitAuthorEmail;
      env.GIT_COMMITTER_EMAIL = this.config.git.commitAuthorEmail;
    }
    await runChecked("git", ["commit", "-m", `${issue.identifier}: ${issue.title}`], {
      cwd,
      env,
      timeoutMs: 120000,
    });
    this.logger.info("git commit created", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
  }

  private async createDraftPr(issue: Issue, workspace: GitWorkspace): Promise<string> {
    const args = [
      "pr",
      "create",
      "--title",
      `${issue.identifier}: ${issue.title}`,
      "--body",
      prBody(issue),
      "--base",
      this.config.git.baseBranch,
      "--head",
      workspace.branchName!,
    ];
    if (this.config.github.draft) {
      args.push("--draft");
    }
    const result = await runChecked("gh", args, { cwd: workspace.runPath, timeoutMs: 120000 });
    const url = result.stdout.trim().split(/\s+/).find((part) => /^https?:\/\//.test(part));
    if (!url) {
      throw new Error(`gh pr create did not return a PR URL: ${result.stdout.trim()}`);
    }
    this.logger.info("github pr created", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      pr_url: url,
    });
    return url;
  }
}

export function successComment(issue: Issue, result: HandoffResult): string {
  const lines = [
    "Symphony run completed.",
    "",
    `Issue: ${issue.identifier}`,
    result.branchName ? `Branch: ${result.branchName}` : null,
    result.commitSha ? `Commit: ${result.commitSha}` : null,
    result.prUrl ? `PR: ${result.prUrl}` : null,
    `Changes: ${result.changed ? "yes" : "no"}`,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function failureComment(issue: Issue, error: string): string {
  return [
    "Symphony run failed.",
    "",
    `Issue: ${issue.identifier}`,
    `Error: ${error.slice(0, 2000)}`,
  ].join("\n");
}

async function hasWorkingTreeChanges(cwd: string): Promise<boolean> {
  const status = await runChecked("git", ["status", "--porcelain"], { cwd, timeoutMs: 30000 });
  return status.stdout.trim().length > 0;
}

function prBody(issue: Issue): string {
  return [
    `Linear issue: ${issue.url ?? issue.identifier}`,
    "",
    "Created by Symphony.",
    "",
    "This PR is a draft for human review. Symphony does not merge automatically.",
  ].join("\n");
}
