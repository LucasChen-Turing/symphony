import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { EffectiveConfig, Logger, Workspace } from "./types.ts";
import { errorMessage, isPathInside, sanitizeWorkspaceKey } from "./util.ts";

export class WorkspaceManager {
  private readonly config: EffectiveConfig;
  private readonly logger: Logger;

  constructor(
    config: EffectiveConfig,
    logger: Logger,
  ) {
    this.config = config;
    this.logger = logger;
  }

  async ensureWorkspace(issueIdentifier: string): Promise<Workspace> {
    const root = path.resolve(this.config.workspace.root);
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.resolve(root, workspaceKey);

    if (!isPathInside(root, workspacePath)) {
      throw new Error(`workspace path escaped root: ${workspacePath}`);
    }

    await fs.mkdir(root, { recursive: true });
    let createdNow = false;
    try {
      await fs.mkdir(workspacePath);
      createdNow = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) {
        throw new Error(`workspace path exists but is not a directory: ${workspacePath}`);
      }
    }

    if (createdNow && this.config.hooks.afterCreate) {
      await this.runHook("after_create", this.config.hooks.afterCreate, workspacePath, true);
    }

    return { path: workspacePath, workspaceKey, createdNow };
  }

  async beforeRun(workspacePath: string): Promise<void> {
    if (this.config.hooks.beforeRun) {
      await this.runHook("before_run", this.config.hooks.beforeRun, workspacePath, true);
    }
  }

  async afterRun(workspacePath: string): Promise<void> {
    if (!this.config.hooks.afterRun) {
      return;
    }
    try {
      await this.runHook("after_run", this.config.hooks.afterRun, workspacePath, false);
    } catch (error) {
      this.logger.warn("hook failed; ignoring", { hook: "after_run", error: errorMessage(error) });
    }
  }

  async removeWorkspace(issueIdentifier: string): Promise<void> {
    const root = path.resolve(this.config.workspace.root);
    const workspacePath = path.resolve(root, sanitizeWorkspaceKey(issueIdentifier));
    if (!isPathInside(root, workspacePath)) {
      throw new Error(`workspace path escaped root: ${workspacePath}`);
    }

    try {
      await fs.access(workspacePath);
    } catch {
      return;
    }

    if (this.config.hooks.beforeRemove) {
      try {
        await this.runHook("before_remove", this.config.hooks.beforeRemove, workspacePath, false);
      } catch (error) {
        this.logger.warn("hook failed; cleanup continuing", { hook: "before_remove", error: errorMessage(error) });
      }
    }

    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  private runHook(name: string, script: string, cwd: string, fatal: boolean): Promise<void> {
    this.logger.info("hook started", { hook: name, cwd });
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-lc", script], { cwd, stdio: "pipe" });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`hook ${name} timed out after ${this.config.hooks.timeoutMs}ms`));
      }, this.config.hooks.timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          this.logger.info("hook completed", { hook: name, cwd });
          resolve();
        } else {
          const message = `hook ${name} failed code=${code} signal=${signal}`;
          if (fatal) {
            reject(new Error(message));
          } else {
            this.logger.warn(message, { hook: name, cwd });
            resolve();
          }
        }
      });
    });
  }
}
