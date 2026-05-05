import fs from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

for (const filePath of await listTypeScriptFiles(srcDir)) {
  const relative = path.relative(srcDir, filePath);
  const target = path.join(distDir, relative).replace(/\.ts$/, ".js");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const source = await fs.readFile(filePath, "utf8");
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  await fs.writeFile(target, rewriteImportExtensions(stripped), "utf8");
}

await import(pathToFileUrl(path.join(distDir, "index.js")));
console.log(`Built ${path.relative(root, distDir)}`);

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function rewriteImportExtensions(source: string): string {
  return source.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2").replace(/(import\(["'][^"']+)\.ts(["']\))/g, "$1.js$2");
}

function pathToFileUrl(filePath: string): string {
  return new URL(`file://${filePath}`).href;
}
