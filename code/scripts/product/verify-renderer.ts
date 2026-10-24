import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  inspectRendererCss,
  inspectRendererHtml,
  inspectRendererModule,
  rendererPrivacyFindings,
} from "./renderer-checks.ts";

const root = "dist/apps/desktop/renderer";
const files = await readdir(root),
  modules = files.filter((name) => name.endsWith(".js"));
assert.ok(
  modules.includes("view.js") && modules.includes("app.js"),
  "Build the renderer before verification",
);
const errors: string[] = [],
  imports = new Map<string, string[]>();
for (const name of files) {
  // A previous prototype/test bundle must never survive a product build, even if nothing imports it.
  if (!/\.(?:js|js\.map|d\.ts|html|css)$/.test(name))
    errors.push(`${name}: unexpected packaged file`);
  const source = await readFile(`${root}/${name}`, "utf8");
  for (const category of rendererPrivacyFindings(source))
    errors.push(`${name}: ${category}`);
  if (name.endsWith(".js")) {
    await readFile(`apps/desktop/renderer/${name.replace(/\.js$/, ".ts")}`);
    const result = inspectRendererModule(name, source);
    errors.push(...result.errors);
    imports.set(name, result.imports);
    for (const target of result.imports)
      if (!modules.includes(target))
        errors.push(`${name}: missing packaged dependency ${target}`);
  }
}
const html = await readFile(`${root}/index.html`, "utf8"),
  css = await readFile(`${root}/style.css`, "utf8");
assert.equal(html, await readFile("apps/desktop/renderer/index.html", "utf8"));
assert.equal(css, await readFile("apps/desktop/renderer/style.css", "utf8"));
errors.push(...inspectRendererHtml(html), ...inspectRendererCss(css));
const reachable = new Set<string>();
function visit(name: string) {
  if (reachable.has(name)) return;
  reachable.add(name);
  for (const target of imports.get(name) ?? []) visit(target);
}
visit("view.js");
assert.ok(
  reachable.has("app.js") && reachable.has("api.js"),
  "Production entry must mount the DesktopApi workbench",
);
const preload = await readFile("dist/apps/desktop/preload/index.cjs", "utf8");
assert.ok(
  /exposeInMainWorld\(["']campusSec["']/.test(preload) &&
    /["']campussec:invoke["']/.test(preload),
  "Packaged preload must expose the existing typed bridge",
);
assert.equal(errors.length, 0, errors.join("\n"));
console.log(
  `PASS: ${modules.length} packaged renderer modules; file:// import closure, local assets, strict CSP, sandbox bridge and privacy patterns.`,
);
console.log(
  "Static product checks only; real Electron/Windows acceptance remains a separate command.",
);
