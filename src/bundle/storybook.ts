import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import type { UsageExample } from "./types.js";

interface TypeScriptModule {
  ScriptTarget: { Latest: number };
  ScriptKind: Record<string, number>;
  SyntaxKind: Record<string, number>;
  createSourceFile(
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number,
  ): SourceFile;
  isVariableStatement(node: Node): node is VariableStatement;
  isIdentifier(node: Node): node is Identifier;
  isObjectLiteralExpression(node: Node): node is ObjectLiteralExpression;
  isPropertyAssignment(node: Node): node is PropertyAssignment;
  isStringLiteral(node: Node): node is LiteralNode;
  isNoSubstitutionTemplateLiteral(node: Node): node is LiteralNode;
  isNumericLiteral(node: Node): node is LiteralNode;
}

interface Node {
  kind: number;
  getText(sourceFile?: SourceFile): string;
}

interface SourceFile extends Node {
  statements: Node[];
}

interface Identifier extends Node {
  text: string;
}

interface LiteralNode extends Node {
  text: string;
}

interface VariableStatement extends Node {
  declarationList: { declarations: VariableDeclaration[] };
  modifiers?: Node[] | undefined;
}

interface VariableDeclaration extends Node {
  name: Node;
  initializer?: Node | undefined;
}

interface ObjectLiteralExpression extends Node {
  properties: Node[];
}

interface PropertyAssignment extends Node {
  name: Node;
  initializer: Node;
}

type StoryArg = string | number | boolean;

export async function loadStorybookExamples(
  componentDir: string,
  componentName: string,
  importPath: string,
  logger: Logger,
): Promise<UsageExample[]> {
  const ts = await loadTypeScript(logger);
  if (!ts) return [];

  const files = await listStoryFiles(componentDir);
  const examples: UsageExample[] = [];
  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file,
      await fs.readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(ts, file),
    );
    examples.push(...readStories(ts, sourceFile, componentName, importPath));
  }
  return examples;
}

async function loadTypeScript(logger: Logger): Promise<TypeScriptModule | null> {
  try {
    return (await import("typescript")) as unknown as TypeScriptModule;
  } catch (err) {
    logger.debug(
      { err: (err as Error).message },
      "typescript package unavailable; skipping Storybook parsing",
    );
    return null;
  }
}

async function listStoryFiles(componentDir: string): Promise<string[]> {
  const entries = await fs.readdir(componentDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(componentDir, entry.name))
    .filter((file) => /\.stories\.(tsx|ts|jsx|js)$/.test(file))
    .sort();
}

function scriptKindFor(ts: TypeScriptModule, file: string): number | undefined {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  return undefined;
}

function readStories(
  ts: TypeScriptModule,
  sourceFile: SourceFile,
  componentName: string,
  importPath: string,
): UsageExample[] {
  const examples: UsageExample[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!isExported(ts, statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
        continue;
      }
      const args = readArgs(ts, declaration.initializer);
      if (!args) continue;
      examples.push({
        name: humanize(declaration.name.text),
        language: "tsx",
        code: storyCode(componentName, importPath, args),
        description: "Generated from Storybook story args.",
      });
    }
  }
  return examples;
}

function readArgs(
  ts: TypeScriptModule,
  storyObject: ObjectLiteralExpression,
): Record<string, StoryArg> | null {
  const argsProperty = propertyNamed(ts, storyObject, "args");
  if (!argsProperty || !ts.isObjectLiteralExpression(argsProperty.initializer)) return null;

  const args: Record<string, StoryArg> = {};
  for (const prop of argsProperty.initializer.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyName(ts, prop.name);
    if (!name) continue;
    const value = literalValue(ts, prop.initializer);
    if (value === null) continue;
    args[name] = value;
  }
  return Object.keys(args).length > 0 ? args : null;
}

function propertyNamed(
  ts: TypeScriptModule,
  object: ObjectLiteralExpression,
  name: string,
): PropertyAssignment | null {
  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (propertyName(ts, prop.name) === name) return prop;
  }
  return null;
}

function propertyName(ts: TypeScriptModule, node: Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return node.text;
  return null;
}

function literalValue(ts: TypeScriptModule, node: Node): StoryArg | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function isExported(ts: TypeScriptModule, statement: VariableStatement): boolean {
  return (statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function storyCode(
  componentName: string,
  importPath: string,
  args: Record<string, StoryArg>,
): string {
  const props = Object.entries(args).filter(([name]) => name !== "children");
  const children = args.children;
  const propText = props.map(([name, value]) => `${name}=${formatPropValue(value)}`).join(" ");
  const open = propText ? `<${componentName} ${propText}>` : `<${componentName}>`;
  const body = typeof children === "string" ? children : "";
  return `import { ${componentName} } from "${importPath}";\n\n${open}${body}</${componentName}>`;
}

function formatPropValue(value: StoryArg): string {
  if (typeof value === "string") return `"${escapeAttribute(value)}"`;
  return `{${String(value)}}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
