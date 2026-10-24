import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

/** Export this simple, single-version graph without invoking npm or executing dependency code.
 * npm ci remains an external verification item; this script never claims it was executed.
 */
const parsed = ts.parseConfigFileTextToJson(
  "bun.lock",
  await readFile("bun.lock", "utf8"),
);
if (parsed.error) throw new Error("Invalid Bun lockfile");
const lock = parsed.config as {
  packages: Record<
    string,
    [string, string?, Record<string, unknown>?, string?]
  >;
  workspaces: Record<
    string,
    {
      name: string;
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
};
const root = JSON.parse(await readFile("package.json", "utf8"));
const packages: Record<string, Record<string, unknown>> = {
  "": {
    name: root.name,
    version: root.version,
    workspaces: root.workspaces,
    dependencies: root.dependencies,
    devDependencies: root.devDependencies,
    engines: root.engines,
  },
};
const dev = new Set<string>();
const production = new Set<string>();
const optional = new Set<string>();
function visit(name: string, isDev: boolean, isOptional = false) {
  const entry = lock.packages[name];
  if (!entry) throw new Error(`Missing locked dependency: ${name}`);
  const visited = isDev ? dev : production;
  if (visited.has(name)) return;
  visited.add(name);
  if (isOptional) optional.add(name);
  if (entry[0].includes("@workspace:")) return;
  const meta = entry[2] ?? {};
  for (const dependency of Object.keys((meta.dependencies ?? {}) as object))
    visit(dependency, isDev);
  for (const dependency of Object.keys(
    (meta.optionalDependencies ?? {}) as object,
  ))
    visit(dependency, isDev, true);
}
for (const workspace of Object.values(lock.workspaces))
  for (const name of Object.keys(workspace.dependencies ?? {}))
    visit(name, false);
for (const name of Object.keys(root.devDependencies ?? {})) visit(name, true);
for (const [path, workspace] of Object.entries(lock.workspaces))
  if (path) {
    packages[path] = { ...workspace };
    packages[`node_modules/${workspace.name}`] = { resolved: path, link: true };
  }
for (const [name, entry] of Object.entries(lock.packages)) {
  if (entry[0].includes("@workspace:")) continue;
  if (!/^(@[^/]+\/)?[^/@]+$/.test(name))
    throw new Error(
      "Nested/multiple-version graph needs a full npm resolver; do not approximate",
    );
  const version = entry[0].slice(name.length + 1);
  const short = name.slice(name.lastIndexOf("/") + 1);
  const candidates = [
    `node_modules/${name}/package.json`,
    `node_modules/.bun/node_modules/${name}/package.json`,
    `node_modules/.bun/${name.replace("/", "+")}@${version}/node_modules/${name}/package.json`,
  ];
  let manifest: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(await readFile(candidate, "utf8"));
      if (value.version === version) {
        manifest = value;
        break;
      }
    } catch {}
  }
  if (!manifest || !entry[3]?.startsWith("sha512-"))
    throw new Error(`Missing verified metadata: ${name}`);
  const value: Record<string, unknown> = {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`,
    integrity: entry[3],
  };
  if (dev.has(name) && !production.has(name)) value.dev = true;
  if (optional.has(name)) value.optional = true;
  for (const field of [
    "license",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "engines",
    "os",
    "cpu",
  ])
    if (manifest[field] !== undefined) value[field] = manifest[field];
  const scripts = manifest.scripts as Record<string, string> | undefined;
  if (scripts?.preinstall || scripts?.install || scripts?.postinstall)
    value.hasInstallScript = true;
  packages[`node_modules/${name}`] = value;
}
const serialized =
  JSON.stringify(
    {
      name: root.name,
      version: root.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile("package-lock.json", "utf8")) !== serialized)
    throw new Error("npm/Bun lock graphs differ");
  console.log(
    "PASS: npm/Bun lock graph metadata matches; this is not npm ci execution.",
  );
} else {
  await writeFile("package-lock.json", serialized);
  console.log(
    "npm v3 lock graph exported from Bun integrity records; npm ci has NOT been executed.",
  );
}
