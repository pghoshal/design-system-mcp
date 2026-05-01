import type { JsxPropValueDetector, Rule, Violation } from "../bundle/types.js";

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
  forEachChild<T>(node: Node, cbNode: (node: Node) => T | undefined): T | undefined;
  isJsxOpeningElement(node: Node): node is JsxOpeningElement;
  isJsxSelfClosingElement(node: Node): node is JsxSelfClosingElement;
  isIdentifier(node: Node): node is Identifier;
  isStringLiteral(node: Node): node is LiteralNode;
  isNoSubstitutionTemplateLiteral(node: Node): node is LiteralNode;
  isJsxExpression(node: Node): node is JsxExpression;
  isNumericLiteral(node: Node): node is LiteralNode;
}

interface Node {
  kind: number;
  getText(sourceFile?: SourceFile): string;
  getStart(sourceFile?: SourceFile): number;
}

interface SourceFile extends Node {
  getLineAndCharacterOfPosition(position: number): { line: number; character: number };
}

interface Identifier extends Node {
  text: string;
}

interface LiteralNode extends Node {
  text: string;
}

interface JsxExpression extends Node {
  expression?: Node | undefined;
}

interface JsxAttribute extends Node {
  name: Identifier;
  initializer?: Node | undefined;
}

interface JsxAttributes {
  properties: Node[];
}

interface JsxOpeningLike extends Node {
  tagName: Node;
  attributes: JsxAttributes;
}

interface JsxOpeningElement extends JsxOpeningLike {}
interface JsxSelfClosingElement extends JsxOpeningLike {}

type LiteralValue = string | number | boolean | true;

export async function runAstDetector(
  rule: Rule,
  code: string,
  language: string,
): Promise<Violation[]> {
  if (rule.detector.type !== "jsx-prop-value") return [];
  if (!["tsx", "jsx", "react-native"].includes(language)) return [];

  const ts = await loadTypeScript();
  if (!ts) return [];

  const sourceFile = ts.createSourceFile(
    language === "jsx" ? "input.jsx" : "input.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    language === "jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.TSX,
  );
  return runJsxPropValueDetector(ts, sourceFile, rule, rule.detector);
}

async function loadTypeScript(): Promise<TypeScriptModule | null> {
  try {
    return (await import("typescript")) as unknown as TypeScriptModule;
  } catch {
    return null;
  }
}

function runJsxPropValueDetector(
  ts: TypeScriptModule,
  sourceFile: SourceFile,
  rule: Rule,
  detector: JsxPropValueDetector,
): Violation[] {
  const violations: Violation[] = [];

  function visit(node: Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const component = jsxTagName(ts, sourceFile, node.tagName);
      if (!detector.component || detector.component === component) {
        const attr = jsxAttribute(ts, node, detector.prop);
        if (attr) {
          const value = attributeValue(ts, attr);
          if (value !== null && violates(detector, value)) {
            const start = attr.getStart(sourceFile);
            const loc = sourceFile.getLineAndCharacterOfPosition(start);
            const match = attr.getText(sourceFile);
            violations.push({
              ruleId: rule.id,
              severity: rule.severity,
              message: detector.message
                .replace(/\{value\}/g, String(value))
                .replace(/\{component\}/g, component)
                .replace(/\{prop\}/g, detector.prop),
              line: loc.line + 1,
              column: loc.character + 1,
              match,
              provenance: {
                ruleSource: "source-repo",
                ...(rule.sourcePath !== undefined ? { rulePath: rule.sourcePath } : {}),
              },
            });
          }
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child);
      return undefined;
    });
  }

  visit(sourceFile);
  return violations;
}

function jsxTagName(ts: TypeScriptModule, sourceFile: SourceFile, node: Node): string {
  if (ts.isIdentifier(node)) return node.text;
  return node.getText(sourceFile);
}

function jsxAttribute(
  ts: TypeScriptModule,
  node: JsxOpeningLike,
  propName: string,
): JsxAttribute | null {
  for (const prop of node.attributes.properties) {
    const maybe = prop as Partial<JsxAttribute>;
    if (maybe.name && ts.isIdentifier(maybe.name) && maybe.name.text === propName) {
      return prop as JsxAttribute;
    }
  }
  return null;
}

function attributeValue(ts: TypeScriptModule, attr: JsxAttribute): LiteralValue | null {
  if (!attr.initializer) return true;
  const init = attr.initializer;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const expression = init.expression;
    if (ts.isStringLiteral(expression)) return expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  }
  return null;
}

function violates(detector: JsxPropValueDetector, value: LiteralValue): boolean {
  if (detector.disallow?.some((item) => item === value)) return true;
  if (detector.allow && !detector.allow.some((item) => item === value)) return true;
  return false;
}
