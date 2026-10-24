import { readdir } from "node:fs/promises";
import { posix } from "node:path";

const generated = new Set([
  "node_modules",
  "dist",
  "dist-test",
  ".git",
  ".cache",
  ".local",
]);
export async function sourceFiles(roots: string[]): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory() && !generated.has(entry.name)) await visit(path);
      else if (
        entry.isFile() &&
        /\.(?:ts|cts)$/.test(path) &&
        !/\.d\.(?:ts|cts)$/.test(path)
      )
        result.push(path);
    }
  }
  for (const root of roots) await visit(root);
  return result.sort();
}
