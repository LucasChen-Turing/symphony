import type { Issue } from "./types.ts";

export class TemplateError extends Error {
  readonly code: "template_parse_error" | "template_render_error";

  constructor(code: "template_parse_error" | "template_render_error", message: string) {
    super(message);
    this.code = code;
  }
}

export function renderPrompt(template: string, issue: Issue, attempt: number | null): string {
  const source = template.trim().length > 0 ? template : "You are working on an issue from Linear.";
  return renderSection(source, { issue, attempt }).trim();
}

function renderSection(source: string, context: Record<string, unknown>): string {
  let output = "";
  let index = 0;
  const tokenPattern = /({{[\s\S]*?}}|{%[\s\S]*?%})/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(source)) !== null) {
    output += source.slice(index, match.index);
    const token = match[0];
    if (token.startsWith("{{")) {
      output += stringifyValue(resolveExpression(token.slice(2, -2).trim(), context));
    } else {
      const tag = token.slice(2, -2).trim();
      if (tag.startsWith("if ")) {
        const [truthySource, falsySource, nextIndex] = splitIfBlock(source, tokenPattern.lastIndex);
        output += isTruthy(resolveExpression(tag.slice(3).trim(), context))
          ? renderSection(truthySource, context)
          : renderSection(falsySource, context);
        tokenPattern.lastIndex = nextIndex;
      } else if (tag === "else" || tag === "endif") {
        throw new TemplateError("template_parse_error", `Unexpected ${tag} tag`);
      } else {
        throw new TemplateError("template_parse_error", `Unsupported tag: ${tag}`);
      }
    }
    index = tokenPattern.lastIndex;
  }

  output += source.slice(index);
  return output;
}

function splitIfBlock(source: string, startIndex: number): [string, string, number] {
  const pattern = /({%[\s\S]*?%})/g;
  pattern.lastIndex = startIndex;
  let depth = 1;
  let elseStart: number | null = null;
  let elseEnd: number | null = null;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const tag = match[0].slice(2, -2).trim();
    if (tag.startsWith("if ")) {
      depth += 1;
    } else if (tag === "endif") {
      depth -= 1;
      if (depth === 0) {
        const truthyEnd = elseStart ?? match.index;
        const falsyStart = elseEnd ?? match.index;
        return [
          source.slice(startIndex, truthyEnd),
          source.slice(falsyStart, match.index),
          pattern.lastIndex,
        ];
      }
    } else if (tag === "else" && depth === 1) {
      elseStart = match.index;
      elseEnd = pattern.lastIndex;
    }
  }

  throw new TemplateError("template_parse_error", "Missing endif tag");
}

function resolveExpression(expression: string, context: Record<string, unknown>): unknown {
  if (expression.includes("|")) {
    throw new TemplateError("template_render_error", `Unknown filters are not supported: ${expression}`);
  }
  if (expression.startsWith("not ")) {
    return !isTruthy(resolveExpression(expression.slice(4).trim(), context));
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(expression)) {
    throw new TemplateError("template_render_error", `Unsupported expression: ${expression}`);
  }

  const parts = expression.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new TemplateError("template_render_error", `Unknown variable: ${expression}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyValue(item)).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}
