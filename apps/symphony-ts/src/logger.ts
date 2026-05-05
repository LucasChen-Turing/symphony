import type { JsonMap, Logger } from "./types.ts";

export class ConsoleLogger implements Logger {
  info(message: string, context: JsonMap = {}): void {
    this.write("info", message, context);
  }

  warn(message: string, context: JsonMap = {}): void {
    this.write("warn", message, context);
  }

  error(message: string, context: JsonMap = {}): void {
    this.write("error", message, context);
  }

  private write(level: string, message: string, context: JsonMap): void {
    const fields = Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(" ");
    const suffix = fields.length > 0 ? ` ${fields}` : "";
    const line = `time=${new Date().toISOString()} level=${level} msg=${quote(message)}${suffix}`;
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return quote(value);
  }
  return quote(JSON.stringify(value));
}

function quote(value: string): string {
  return JSON.stringify(value);
}
