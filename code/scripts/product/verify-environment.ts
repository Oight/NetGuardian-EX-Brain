import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(
  major === 24 && minor! >= 15,
  "campussec requires Node >=24.15 <25; use code/.node-version before installing/running checks",
);
const pinned = (await readFile(".node-version", "utf8")).trim();
assert.equal(pinned, "24.15.0");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(manifest.packageManager, "npm@11.12.1");
const npmVersion =
  process.env.npm_config_user_agent?.match(/^npm\/([0-9.]+)/)?.[1];
if (npmVersion)
  assert.equal(
    npmVersion,
    "11.12.1",
    "Use the pinned npm 11.12.1 shipped with Node 24.15.0 for reproducible checks",
  );
console.log(
  `PASS: Node ${process.versions.node}; tested minimum ${pinned}; ${process.platform}/${process.arch}.`,
);
