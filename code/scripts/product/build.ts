import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// process.execPath is Bun for local execution and Node for other members' npm scripts.
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
async function directory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
for (const entry of await readdir("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const output = join("dist", "packages", entry.name);
  if (!(await directory(output))) continue; // Documentation-only modules have no build output.
  const source = (await directory(join(output, "src")))
    ? join(output, "src")
    : output;
  await cp(source, join("packages", entry.name, "dist"), { recursive: true });
}
await mkdir("dist/packages/storage/migrations", { recursive: true });
await cp("packages/storage/migrations", "dist/packages/storage/migrations", {
  recursive: true,
});
for (const file of ["index.html", "style.css"])
  await cp(
    `apps/desktop/renderer/${file}`,
    `dist/apps/desktop/renderer/${file}`,
  );
await cp("apps/desktop/assets", "dist/apps/desktop/assets", {
  recursive: true,
});
await writeFile(
  "dist/build-info.json",
  JSON.stringify(
    {
      businessBaseline: "v4.2",
      engineeringContract: "0.2.0",
      wireSchema: "0.1.0",
      executedWith: process.versions.bun ? "Bun" : "Node.js",
      electronExecuted: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "ES modules and sandboxed preload compiled; Electron was not started.",
);
