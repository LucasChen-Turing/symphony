import fs from "node:fs/promises";
import path from "node:path";

export async function loadLocalEnv(paths: string[]): Promise<string[]> {
  const loaded: string[] = [];
  for (const filePath of unique(paths.map((entry) => path.resolve(entry)))) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      applyEnvFile(content);
      loaded.push(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return loaded;
}

function applyEnvFile(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    key: match[1]!,
    value: unquote(match[2]!.trim()),
  };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const commentStart = value.indexOf(" #");
  return commentStart === -1 ? value : value.slice(0, commentStart).trimEnd();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
