#!/usr/bin/env node
import path from "node:path";
import { loadLocalEnv } from "./env.ts";
import { ConsoleLogger } from "./logger.ts";
import { Orchestrator } from "./orchestrator.ts";
import { WorkflowStore } from "./workflow-store.ts";

interface CliOptions {
  workflowPath: string;
  once: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = new ConsoleLogger();
  const loadedEnvFiles = await loadLocalEnv([
    path.join(process.cwd(), ".env.local"),
    path.join(path.dirname(options.workflowPath), ".env.local"),
  ]);
  for (const filePath of loadedEnvFiles) {
    logger.info("loaded local env file", { path: filePath });
  }
  const orchestrator = new Orchestrator(new WorkflowStore(options.workflowPath), logger, {
    once: options.once,
    enableRetries: !options.once,
  });

  await orchestrator.start();
  if (options.once) {
    await orchestrator.waitForIdle();
    logger.info("single poll completed", orchestrator.snapshot());
    return;
  }

  const shutdown = async () => {
    logger.info("shutdown requested");
    await orchestrator.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function parseArgs(args: string[]): CliOptions {
  let workflowPath = path.join(process.cwd(), "WORKFLOW.md");
  let once = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--workflow") {
      workflowPath = args[++index] ?? workflowPath;
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    workflowPath: path.resolve(workflowPath),
    once,
  };
}

function printHelp(): void {
  console.log(`Usage: npm start -- [--workflow WORKFLOW.md] [--once]

Options:
  --workflow PATH  Workflow file to load. Defaults to ./WORKFLOW.md.
  --once           Run one poll cycle, wait for active commands, then exit.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
