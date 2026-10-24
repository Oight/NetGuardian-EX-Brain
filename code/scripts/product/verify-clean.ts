import { cp, mkdir, mkdtemp, access, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";
const root = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error(
    "Run via npm run check:clean so the current npm CLI is explicit",
  );
await access(npmCli);
await mkdir(".local/clean-check", { recursive: true });
const target = await mkdtemp(resolve(".local/clean-check/run-"));
const excluded = new Set([
  "node_modules",
  "dist",
  "dist-test",
  ".local",
  ".cache",
  ".git",
  ".idea",
  ".venv",
  "__pycache__",
]);
for (const entry of await readdir(root)) {
  if (!excluded.has(entry))
    await cp(resolve(root, entry), resolve(target, entry), {
      recursive: true,
      filter: (source) =>
        !relative(root, source)
          .split(sep)
          .some((part) => excluded.has(part)),
    });
}
const cache = resolve(".cache/npm");
function run(args: string[]) {
  const result = spawnSync(process.execPath, [npmCli!, ...args], {
    cwd: target,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// An offline frozen install proves we do not use existing modules or generated package exports.
run([
  "ci",
  "--offline",
  "--ignore-scripts",
  "--cache",
  cache,
  "--no-audit",
  "--no-fund",
]);
run(["run", "check"]);
console.log(
  "PASS: clean source copy + frozen offline npm install + all checks; generated artifacts excluded.",
);
