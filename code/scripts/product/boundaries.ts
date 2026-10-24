import { posix } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";

export interface Architecture {
  components: Record<
    string,
    { module: string; path: string; dependsOn: string[] }
  >;
  tableOwners: Record<string, string[]>;
}

export function componentFor(
  path: string,
  spec: Architecture,
): string | undefined {
  if (path.startsWith("packages/testkit/")) return "testkit";
  if (path.startsWith("packages/investigation-profile/")) return "reports";
  if (path.startsWith("apps/desktop/preload/")) return "preload";
  if (path.startsWith("packages/core/investigations/completion."))
    return "requests";
  const entries = Object.entries(spec.components).sort(
    (a, b) => b[1].path.length - a[1].path.length,
  );
  const found = entries.find(
    ([, value]) =>
      path === value.path ||
      path.startsWith(value.path + "/") ||
      path.startsWith(value.path + "."),
  );
  if (found) return found[0];
  if (path.startsWith("apps/desktop/main/")) return "runtime";
  return undefined;
}

export function checkSource(
  path: string,
  source: string,
  spec: Architecture,
): string[] {
  const errors: string[] = [];
  const component = componentFor(path, spec);
  if (!component)
    return [`${path}: source directory has no declared component`];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const owner = spec.components[component]?.module;
  const allowed =
    component === "testkit" || component === "preload"
      ? ["common"]
      : (spec.components[component]?.dependsOn ?? []);
  const error = (message: string) => errors.push(`${path}: ${message}`);
  const moduleFor = (target: string) => {
    if (target.startsWith("."))
      return componentFor(
        posix.normalize(posix.join(posix.dirname(path), target)),
        spec,
      );
    if (!target.startsWith("@campussec/")) return undefined;
    const suffix = target.slice("@campussec/".length);
    return componentFor("packages/" + suffix + "/index.ts", spec);
  };
  const checkImport = (target: string) => {
    if (target.startsWith("bun:")) error(`Bun-only import ${target}`);
    if (component === "common" && !target.startsWith(".") && target !== "zod")
      error(`contracts infrastructure import ${target}`);
    if (
      component === "testkit" &&
      !target.startsWith(".") &&
      target !== "@campussec/contracts"
    )
      error(`testkit must be independent of infrastructure: ${target}`);
    if (target === "electron" && !["runtime", "preload"].includes(component))
      error("Electron outside main/preload");
    if (["ui", "preload"].includes(component) && isBuiltin(target))
      error("privileged Node API in renderer/preload");
    if (
      component === "preload" &&
      !target.startsWith(".") &&
      target !== "electron" &&
      target !== "@campussec/contracts"
    )
      error(`preload import is not allowed: ${target}`);
    if (
      component === "ui" &&
      !target.startsWith(".") &&
      target !== "@campussec/contracts"
    )
      error(`renderer must use DesktopApi: ${target}`);
    if (
      /\/(?:src|internal|repositories)(?:\/|\.)/.test(target) &&
      !target.startsWith(".")
    )
      error(`private package import ${target}`);
    if (
      target.includes("/tests/") ||
      target.includes("/testing/") ||
      target.includes("/testkit") ||
      target.includes("tests/support")
    )
      error(`test dependency in production ${target}`);
    const dependency = moduleFor(target);
    if (target.startsWith("@campussec/") && !dependency)
      error(`undeclared public component ${target}`);
    if (target.startsWith(".") && !dependency)
      error(`relative import escapes component ${target}`);
    if (dependency && dependency !== component && !allowed.includes(dependency))
      error(`forbidden dependency ${component} -> ${dependency}`);
    if (target.startsWith(".") && dependency && dependency !== component) {
      const otherOwner = spec.components[dependency]?.module;
      if (owner !== otherOwner)
        error(`cross-module import must use a public package: ${target}`);
    }
  };
  const checkSql = (text: string) => {
    for (const match of text.matchAll(
      /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+["`\[]?(\w+)/gi,
    )) {
      const table = match[1]!.toLowerCase();
      const tableOwner = Object.entries(spec.tableOwners).find(([, names]) =>
        names.includes(table),
      )?.[0];
      if (tableOwner && tableOwner !== owner)
        error(
          `SQL write to ${table} belongs to ${tableOwner}, not ${owner ?? component}`,
        );
    }
  };
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      checkImport(node.moduleSpecifier.text);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    )
      checkImport(node.moduleReference.expression.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      checkImport(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const target = node.arguments[0];
      if (target && ts.isStringLiteralLike(target)) checkImport(target.text);
      else error("non-literal import/require cannot be checked");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Bun"
    )
      error("Bun-specific runtime API");
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      checkSql(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...new Set(errors)];
}
