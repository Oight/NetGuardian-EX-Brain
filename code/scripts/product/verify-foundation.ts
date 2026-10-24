import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";
import { desktopSchemas, dtoSchemas } from "@campussec/contracts";

const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const provenance = JSON.parse(
  await readFile("spec/provenance.json", "utf8"),
) as { files: { name: string; sha256: string }[] };
for (const entry of provenance.files)
  assert.equal(
    hash(await readFile(`spec/${entry.name}`)),
    entry.sha256,
    `Specification changed: ${entry.name}`,
  );
assert.equal(
  hash(await readFile("packages/storage/migrations/0001.sql")),
  hash(await readFile("spec/schema.sql")),
  "Migration must match the 0.2.0 DDL",
);
const source = ts.createSourceFile(
  "contracts.ts",
  await readFile("spec/contracts.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
function declarations(file: ts.SourceFile) {
  return file.statements
    .map((node) => {
      const name = ts.isVariableStatement(node)
        ? node.declarationList.declarations[0]!.name.getText(file)
        : ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
          ? node.name.text
          : undefined;
      return name ? ([name, node.getText(file)] as const) : undefined;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined);
}
const productDeclarations = new Map<string, string>();
for (const name of await readdir("packages/contracts/src/domains")) {
  const file = ts.createSourceFile(
    name,
    await readFile(`packages/contracts/src/domains/${name}`, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const [key, value] of declarations(file)) {
    assert.ok(!productDeclarations.has(key), `Duplicate declaration: ${key}`);
    productDeclarations.set(key, value);
  }
}
assert.deepEqual(
  [...productDeclarations].sort(),
  declarations(source).sort(),
  "Domain declarations must exactly match the original contract",
);
const desktop = source.statements.find(
  (node) =>
    ts.isInterfaceDeclaration(node) && node.name.text === "DesktopMethodMap",
) as ts.InterfaceDeclaration;
const methods = desktop.members
  .map((member) => (member.name as ts.StringLiteral).text)
  .sort();
assert.deepEqual(
  Object.keys(desktopSchemas).sort(),
  methods,
  "Every desktop input/output needs a schema",
);
// HttpRequest/PlatformCall contain live AbortSignal/callback handles, not JSON DTOs.
const special = new Set([
  "HttpRequest",
  "PlatformCall",
  "DesktopMethodMap",
  "EventPayloadMap",
  "RpcRequest",
  "RpcResponse",
]);
const dataInterfaces = source.statements
  .filter(ts.isInterfaceDeclaration)
  .filter(
    (node) =>
      !special.has(node.name.text) &&
      !/(?:Port|Service|Api|Tx)$/.test(node.name.text) &&
      !node.members.some(ts.isMethodSignature),
  );
for (const node of dataInterfaces)
  assert.ok(
    Object.hasOwn(dtoSchemas, node.name.text),
    `Missing DTO schema: ${node.name.text}`,
  );
const preload = await readFile("apps/desktop/preload/index.cts", "utf8");
assert.ok(preload.includes("ipcRenderer.invoke('campussec:invoke', request)"));
assert.ok(
  !preload.includes("ipcRenderer.on(") &&
    !preload.includes("ipcRenderer.send("),
);
const bootstrap = await readFile("apps/desktop/main/bootstrap.ts", "utf8");
for (const setting of [
  "nodeIntegration:false",
  "contextIsolation:true",
  "sandbox:true",
  "webSecurity:true",
])
  assert.ok(bootstrap.includes(setting));
const electronManifest = JSON.parse(
  await readFile("node_modules/electron/package.json", "utf8"),
);
assert.equal(electronManifest.version, "45.0.0");
// A successful Electron postinstall would create this file; local installs must not do that.
if (process.versions.bun) {
  let binaryInstalled = false;
  try {
    await readFile("node_modules/electron/path.txt");
    binaryInstalled = true;
  } catch {}
  assert.equal(
    binaryInstalled,
    false,
    "Electron install hook must not run locally",
  );
}
console.log(
  `PASS: ${methods.length} Desktop methods, ${dataInterfaces.length} DTO interfaces, contract/DDL hashes and desktop security configuration.`,
);
