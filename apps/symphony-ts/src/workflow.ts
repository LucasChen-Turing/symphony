import fs from "node:fs/promises";
import path from "node:path";
import type { JsonMap, WorkflowDefinition } from "./types.ts";

export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function loadWorkflow(workflowPath?: string): Promise<WorkflowDefinition> {
  const selected = path.resolve(workflowPath ?? path.join(process.cwd(), "WORKFLOW.md"));
  let content: string;
  try {
    content = await fs.readFile(selected, "utf8");
  } catch (error) {
    throw new WorkflowError("missing_workflow_file", `Unable to read ${selected}: ${String(error)}`);
  }
  return parseWorkflow(content);
}

export function parseWorkflow(content: string): WorkflowDefinition {
  const lines = content.split(/\r?\n/);
  let config: JsonMap = {};
  let promptLines = lines;

  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    const frontMatter = end === -1 ? lines.slice(1) : lines.slice(1, end);
    promptLines = end === -1 ? [] : lines.slice(end + 1);
    try {
      const decoded = parseYaml(frontMatter.join("\n"));
      if (!isPlainObject(decoded)) {
        throw new WorkflowError("workflow_front_matter_not_a_map", "YAML front matter must decode to an object");
      }
      config = decoded;
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw error;
      }
      throw new WorkflowError("workflow_parse_error", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    config,
    prompt_template: promptLines.join("\n").trim(),
  };
}

function parseYaml(source: string): unknown {
  const lines = source.split(/\r?\n/);
  const [value] = parseBlock(lines, 0, 0);
  return value ?? {};
}

function parseBlock(lines: string[], index: number, indent: number): [unknown, number] {
  index = skipEmpty(lines, index);
  if (index >= lines.length) {
    return [{}, index];
  }

  const first = lines[index]!;
  const firstIndent = countIndent(first);
  if (firstIndent < indent) {
    return [{}, index];
  }

  return first.trimStart().startsWith("- ")
    ? parseArray(lines, index, firstIndent)
    : parseObject(lines, index, firstIndent);
}

function parseObject(lines: string[], index: number, indent: number): [JsonMap, number] {
  const result: JsonMap = {};

  while (index < lines.length) {
    index = skipEmpty(lines, index);
    if (index >= lines.length) {
      break;
    }

    const line = lines[index]!;
    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }
    if (currentIndent > indent) {
      throw new Error(`Unexpected indentation at line ${index + 1}`);
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      break;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`Expected key/value pair at line ${index + 1}`);
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (key.length === 0) {
      throw new Error(`Empty key at line ${index + 1}`);
    }

    if (rawValue === "|" || rawValue === ">") {
      const [block, nextIndex] = collectBlockScalar(lines, index + 1, indent + 2, rawValue === ">");
      result[key] = block;
      index = nextIndex;
    } else if (rawValue.length === 0) {
      const next = skipEmpty(lines, index + 1);
      if (next >= lines.length || countIndent(lines[next]!) <= indent) {
        result[key] = {};
        index += 1;
      } else {
        const [child, nextIndex] = parseBlock(lines, next, countIndent(lines[next]!));
        result[key] = child;
        index = nextIndex;
      }
    } else {
      result[key] = parseScalar(rawValue);
      index += 1;
    }
  }

  return [result, index];
}

function parseArray(lines: string[], index: number, indent: number): [unknown[], number] {
  const result: unknown[] = [];

  while (index < lines.length) {
    index = skipEmpty(lines, index);
    if (index >= lines.length) {
      break;
    }

    const line = lines[index]!;
    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }
    if (currentIndent > indent) {
      throw new Error(`Unexpected indentation at line ${index + 1}`);
    }

    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) {
      break;
    }

    const rawValue = trimmed.slice(2).trim();
    if (rawValue.length === 0) {
      const next = skipEmpty(lines, index + 1);
      if (next >= lines.length || countIndent(lines[next]!) <= indent) {
        result.push(null);
        index += 1;
      } else {
        const [child, nextIndex] = parseBlock(lines, next, countIndent(lines[next]!));
        result.push(child);
        index = nextIndex;
      }
    } else if (looksLikeInlineObject(rawValue)) {
      const [objectValue, nextIndex] = parseInlineObjectListItem(lines, index, indent, rawValue);
      result.push(objectValue);
      index = nextIndex;
    } else {
      result.push(parseScalar(rawValue));
      index += 1;
    }
  }

  return [result, index];
}

function parseInlineObjectListItem(lines: string[], index: number, indent: number, rawValue: string): [JsonMap, number] {
  const separator = rawValue.indexOf(":");
  const result: JsonMap = {
    [rawValue.slice(0, separator).trim()]: parseScalar(rawValue.slice(separator + 1).trim()),
  };
  index += 1;

  while (index < lines.length) {
    index = skipEmpty(lines, index);
    if (index >= lines.length) {
      break;
    }

    const currentIndent = countIndent(lines[index]!);
    if (currentIndent <= indent) {
      break;
    }

    const [child, nextIndex] = parseObject(lines, index, currentIndent);
    Object.assign(result, child);
    index = nextIndex;
  }

  return [result, index];
}

function collectBlockScalar(lines: string[], index: number, indent: number, fold: boolean): [string, number] {
  const block: string[] = [];

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      block.push("");
      index += 1;
      continue;
    }
    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }
    block.push(line.slice(Math.min(indent, line.length)));
    index += 1;
  }

  return [fold ? block.join(" ").trimEnd() : block.join("\n").trimEnd(), index];
}

function parseScalar(value: string): unknown {
  if (value === "null" || value === "~") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return value;
}

function looksLikeInlineObject(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\s*:/.test(value);
}

function countIndent(line: string): number {
  const match = /^ */.exec(line);
  return match?.[0].length ?? 0;
}

function skipEmpty(lines: string[], index: number): number {
  while (index < lines.length) {
    const trimmed = lines[index]!.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      break;
    }
    index += 1;
  }
  return index;
}

function isPlainObject(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
