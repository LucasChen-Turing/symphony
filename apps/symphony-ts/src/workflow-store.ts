import fs from "node:fs/promises";
import path from "node:path";
import type { EffectiveConfig, WorkflowDefinition } from "./types.ts";
import { resolveConfig } from "./config.ts";
import { loadWorkflow } from "./workflow.ts";

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  config: EffectiveConfig & { promptTemplate: string };
  mtimeMs: number;
}

export class WorkflowStore {
  private currentWorkflow: LoadedWorkflow | null = null;
  private readonly workflowPath: string;

  constructor(workflowPath: string) {
    this.workflowPath = workflowPath;
  }

  async loadInitial(): Promise<LoadedWorkflow> {
    this.currentWorkflow = await this.load();
    return this.currentWorkflow;
  }

  async getCurrent(): Promise<LoadedWorkflow> {
    if (!this.currentWorkflow) {
      return this.loadInitial();
    }
    const stat = await fs.stat(this.workflowPath);
    if (stat.mtimeMs !== this.currentWorkflow.mtimeMs) {
      const reloaded = await this.load();
      this.currentWorkflow = reloaded;
    }
    return this.currentWorkflow;
  }

  private async load(): Promise<LoadedWorkflow> {
    const absolutePath = path.resolve(this.workflowPath);
    const definition = await loadWorkflow(absolutePath);
    const stat = await fs.stat(absolutePath);
    const config = resolveConfig(definition.config, absolutePath) as EffectiveConfig & { promptTemplate: string };
    config.promptTemplate = definition.prompt_template;
    return {
      definition,
      config,
      mtimeMs: stat.mtimeMs,
    };
  }
}
