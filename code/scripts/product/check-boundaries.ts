import { readFile } from "node:fs/promises";
import { checkSource, type Architecture } from "./boundaries.ts";
import { sourceFiles } from "./files.ts";

const spec = JSON.parse(
  await readFile("spec/architecture.json", "utf8"),
) as Architecture;
const paths = (await sourceFiles(["packages", "apps"])).filter(
  (path) =>
    !/\/(?:tests|fixtures|testing)\//.test(path) && !path.endsWith(".test.ts"),
);
const errors: string[] = [];
for (const path of paths)
  errors.push(...checkSource(path, await readFile(path, "utf8"), spec));
if (errors.length) throw new Error("\n" + errors.join("\n"));
console.log(
  `PASS: ${paths.length} source files; declared component imports, pure testkit, renderer privileges and literal SQL write ownership.`,
);
console.log(
  "Static checks do not establish runtime authorization or validate dynamically constructed SQL.",
);
