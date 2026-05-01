import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import type { ComponentProp } from "./types.js";

interface TypeScriptModule {
  ScriptTarget: { Latest: number };
  ScriptKind: Record<string, number>;
  createSourceFile(
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number,
  ): SourceFile;
  forEachChild<T>(node: Node, cbNode: (node: Node) => T | undefined): T | undefined;
  isInterfaceDeclaration(node: Node): node is InterfaceDeclaration;
  isTypeAliasDeclaration(node: Node): node is TypeAliasDeclaration;
  isTypeLiteralNode(node: Node): node is TypeLiteralNode;
  isPropertySignature(node: Node): node is PropertySignature;
  isIdentifier(node: Node): node is Identifier;
  isStringLiteral(node: Node): node is StringLiteral;
  isUnionTypeNode(node: Node): node is UnionTypeNode;
  getJSDocCommentsAndTags(node: Node): Node[];
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

interface StringLiteral extends Node {
  text: string;
}

interface TypeElement extends Node {}

interface InterfaceDeclaration extends Node {
  name: Identifier;
  members: TypeElement[];
}

interface TypeAliasDeclaration extends Node {
  name: Identifier;
  type: Node;
}

interface TypeLiteralNode extends Node {
  members: TypeElement[];
}

interface PropertySignature extends TypeElement {
  name: Node;
  questionToken?: Node | undefined;
  type?: Node | undefined;
}

interface UnionTypeNode extends Node {
  types: Node[];
}

interface PropsDeclaration {
  name: string;
  sourceFile: SourceFile;
  node: InterfaceDeclaration | TypeLiteralNode;
}

export async function loadComponentApiProps(
  componentDir: string,
  componentName: string,
  logger: Logger,
): Promise<ComponentProp[]> {
  const ts = await loadTypeScript(logger);
  if (!ts) return [];

  const files = await listApiFiles(componentDir);
  const preferredName = `${componentName}Props`;
  const declarations: PropsDeclaration[] = [];

  for (const file of files) {
    const sourceText = await fs.readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(ts, file),
    );
    declarations.push(...findPropsDeclarations(ts, sourceFile));
  }

  const declaration =
    declarations.find((candidate) => candidate.name === preferredName) ?? declarations[0];
  if (!declaration) return [];

  return readProps(ts, declaration.sourceFile, declaration.node);
}

async function loadTypeScript(logger: Logger): Promise<TypeScriptModule | null> {
  try {
    return (await import("typescript")) as unknown as TypeScriptModule;
  } catch (err) {
    logger.debug(
      { err: (err as Error).message },
      "typescript package unavailable; skipping component API parsing",
    );
    return null;
  }
}

async function listApiFiles(componentDir: string): Promise<string[]> {
  const entries = await fs.readdir(componentDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(componentDir, entry.name))
    .filter((file) => /\.(tsx|ts|jsx|js)$/.test(file) && !/\.d\.ts$/.test(file))
    .sort();
}

function scriptKindFor(ts: TypeScriptModule, file: string): number | undefined {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  return undefined;
}

function findPropsDeclarations(ts: TypeScriptModule, sourceFile: SourceFile): PropsDeclaration[] {
  const declarations: PropsDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text.endsWith("Props")) {
      declarations.push({ name: statement.name.text, sourceFile, node: statement });
    }
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text.endsWith("Props") &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      declarations.push({ name: statement.name.text, sourceFile, node: statement.type });
    }
  }
  return declarations;
}

function readProps(
  ts: TypeScriptModule,
  sourceFile: SourceFile,
  propsNode: InterfaceDeclaration | TypeLiteralNode,
): ComponentProp[] {
  const members = propsNode.members;
  const out: ComponentProp[] = [];

  for (const member of members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = propName(ts, sourceFile, member.name);
    if (!name) continue;
    const type = member.type?.getText(sourceFile) ?? "unknown";
    const jsDoc = parseJsDoc(ts, sourceFile, member);
    out.push({
      name,
      type,
      required: member.questionToken === undefined,
      ...(jsDoc.description !== undefined ? { description: jsDoc.description } : {}),
      values: unionStringValues(ts, sourceFile, member.type),
      ...(jsDoc.defaultValue !== undefined ? { default: jsDoc.defaultValue } : {}),
      ...(jsDoc.deprecated ? { deprecated: true } : {}),
      ...(jsDoc.replacedBy !== undefined ? { replacedBy: jsDoc.replacedBy } : {}),
      ...(isControlledPropName(name) ? { controlled: true } : {}),
    });
  }

  return out;
}

function propName(ts: TypeScriptModule, sourceFile: SourceFile, node: Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return node.text;
  const text = node.getText(sourceFile).replace(/^["']|["']$/g, "");
  return text.length > 0 ? text : null;
}

function parseJsDoc(
  ts: TypeScriptModule,
  sourceFile: SourceFile,
  node: Node,
): {
  description?: string | undefined;
  defaultValue?: string | number | boolean | undefined;
  deprecated: boolean;
  replacedBy?: string | undefined;
} {
  const raw = ts
    .getJSDocCommentsAndTags(node)
    .map((doc) =>
      doc
        .getText(sourceFile)
        .replace(/^\/\*\*?/, "")
        .replace(/\*\/$/, "")
        .replace(/^\s*\* ?/gm, "")
        .trim(),
    )
    .filter(Boolean);
  const text = raw.join("\n").trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const descriptionLines = lines.filter((line) => !line.startsWith("@"));
  const defaultLine = lines.find((line) => line.startsWith("@default"));
  const deprecatedLine = lines.find((line) => line.startsWith("@deprecated"));
  return {
    description: descriptionLines.length > 0 ? descriptionLines.join(" ") : undefined,
    defaultValue: defaultLine
      ? parseDefaultValue(defaultLine.replace(/^@default\s*/, ""))
      : undefined,
    deprecated: deprecatedLine !== undefined,
    ...(deprecatedLine !== undefined
      ? { replacedBy: replacementFromDeprecated(deprecatedLine) }
      : {}),
  };
}

function unionStringValues(
  ts: TypeScriptModule,
  sourceFile: SourceFile,
  type: Node | undefined,
): string[] | undefined {
  if (!type || !ts.isUnionTypeNode(type)) return undefined;
  const values = type.types
    .map((part) => stringLiteralValue(part.getText(sourceFile)))
    .filter((value): value is string => value !== null);
  return values.length > 0 && values.length === type.types.length ? values : undefined;
}

function stringLiteralValue(text: string): string | null {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return null;
}

function parseDefaultValue(raw: string): string | number | boolean | undefined {
  const value = raw.trim().replace(/[.;]$/, "");
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(value)) return numeric;
  return value.replace(/^["']|["']$/g, "");
}

function replacementFromDeprecated(line: string): string | undefined {
  const match = /\buse\s+([A-Za-z_$][\w$.-]*)\s+instead\b/i.exec(line);
  return match?.[1];
}

function isControlledPropName(name: string): boolean {
  return /^(value|checked|selected|open|expanded|active|pressed)$/i.test(name);
}
