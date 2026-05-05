import type { Bundle, Entity, RuleLanguage, Violation } from "../bundle/types.js";
import { cssTokenVar } from "../util/css-token-name.js";

export const SEMANTIC_TOKEN_RULE_IDS = [
  "no-raw-length-values",
  "no-raw-color-functions",
  "no-unknown-css-vars",
  "prefer-semantic-tokens",
  "no-deprecated-tokens",
] as const;

export type SemanticTokenRuleId = (typeof SEMANTIC_TOKEN_RULE_IDS)[number];

const SUPPORTED_LANGUAGES = new Set<RuleLanguage>([
  "tsx",
  "jsx",
  "ts",
  "js",
  "css",
  "html",
  "vue",
  "react-native",
]);

interface CssToken {
  entity: Entity;
  cssVar: string;
  isSemantic: boolean;
}

interface CssTokenIndex {
  tokens: Map<string, CssToken>;
  tokenStems: Set<string>;
}

export function runSemanticTokenValidation(
  bundle: Bundle,
  code: string,
  language: RuleLanguage,
  selectedRules: ReadonlySet<string> | null,
): { violations: Violation[]; ranRules: string[] } {
  if (!SUPPORTED_LANGUAGES.has(language)) return { violations: [], ranRules: [] };

  const availableRules = SEMANTIC_TOKEN_RULE_IDS.filter(
    (id) => !selectedRules || selectedRules.has(id),
  );
  if (availableRules.length === 0) return { violations: [], ranRules: [] };

  const tokenIndex = cssTokenIndex(bundle);
  const violations: Violation[] = [];

  if (availableRules.includes("no-raw-length-values")) {
    violations.push(...findRawLengths(code));
  }
  if (availableRules.includes("no-raw-color-functions")) {
    violations.push(...findRawColorFunctions(code));
  }
  if (
    availableRules.includes("no-unknown-css-vars") ||
    availableRules.includes("prefer-semantic-tokens") ||
    availableRules.includes("no-deprecated-tokens")
  ) {
    violations.push(...findCssVarProblems(code, tokenIndex, availableRules));
  }

  return { violations, ranRules: availableRules };
}

function cssTokenIndex(bundle: Bundle): CssTokenIndex {
  const tokens = new Map<string, CssToken>();
  const tokenStems = new Set<string>();
  for (const entity of bundle.entities.values()) {
    if (entity.type !== "token") continue;
    const path = entity.data.path;
    if (!Array.isArray(path) || !path.every((p) => typeof p === "string")) continue;
    const cssVar = cssTokenVar(path);
    const stem = cssVarStem(cssVar);
    if (stem) tokenStems.add(stem);
    const original = entity.data.original;
    tokens.set(cssVar, {
      entity,
      cssVar,
      isSemantic: isSemanticToken(path, original),
    });
  }
  return { tokens, tokenStems };
}

function isSemanticToken(path: string[], original: unknown): boolean {
  if (typeof original === "string" && original.startsWith("{") && original.endsWith("}")) {
    return true;
  }

  const [family, role] = path;
  if (family === undefined) return false;

  if (family === "color") {
    return role !== undefined && SEMANTIC_COLOR_ROLES.has(role);
  }

  return SEMANTIC_TOKEN_FAMILIES.has(family);
}

const SEMANTIC_COLOR_ROLES = new Set(["action", "border", "focus", "status", "surface", "text"]);

const SEMANTIC_TOKEN_FAMILIES = new Set([
  "app",
  "breakpoint",
  "component",
  "dataviz",
  "density",
  "elevation",
  "layer",
  "motion",
  "platform",
  "state",
  "theme",
]);

function findRawLengths(code: string): Violation[] {
  const re = /(?<![\w.-])-?\d+(?:\.\d+)?(?:px|rem|em)\b/g;
  return scan(code, re, (match) => ({
    ruleId: "no-raw-length-values",
    severity: "error",
    message: `Raw length value ${match} must use a design token.`,
    match,
    provenance: { ruleSource: "built-in" },
  }));
}

function findRawColorFunctions(code: string): Violation[] {
  const re = /\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi;
  return scan(code, re, (match) => ({
    ruleId: "no-raw-color-functions",
    severity: "error",
    message: `Raw color function ${match} must use a color token.`,
    match,
    provenance: { ruleSource: "built-in" },
  }));
}

function findCssVarProblems(
  code: string,
  tokenIndex: CssTokenIndex,
  activeRules: readonly string[],
): Violation[] {
  const out: Violation[] = [];
  const lines = code.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const usages = extractCssVarUsages(line);
    for (const usage of usages) {
      const violation = cssVarViolation(usage, tokenIndex, activeRules);
      if (!violation) continue;
      out.push({
        ...violation,
        line: lineIndex + 1,
        column: usage.column,
      });
    }
  }

  return out;
}

interface CssVarUsage {
  cssVar: string;
  match: string;
  column: number;
}

function extractCssVarUsages(line: string): CssVarUsage[] {
  const out: CssVarUsage[] = [];
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const start = line.indexOf("var(", searchFrom);
    if (start === -1) break;

    let depth = 0;
    let end = -1;
    for (let i = start + 3; i < line.length; i++) {
      const char = line[i];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }

    if (end === -1) {
      searchFrom = start + 4;
      continue;
    }

    const match = line.slice(start, end);
    const cssVar = match.match(/^var\(\s*(--[a-zA-Z0-9-_]+)/)?.[1];
    if (cssVar) {
      out.push({
        cssVar,
        match,
        column: start + 1,
      });
    }
    searchFrom = start + 4;
  }

  return out;
}

function cssVarViolation(
  usage: CssVarUsage,
  tokenIndex: CssTokenIndex,
  activeRules: readonly string[],
): Omit<Violation, "line" | "column"> | null {
  const cssVar = usage.cssVar;
  const token = tokenIndex.tokens.get(cssVar);
  if (!token && activeRules.includes("no-unknown-css-vars")) {
    if (!isTokenLikeCssVar(cssVar, tokenIndex.tokenStems)) return null;
    return {
      ruleId: "no-unknown-css-vars",
      severity: "error",
      message: `Unknown CSS token variable ${cssVar}.`,
      match: usage.match,
      provenance: { ruleSource: "built-in" },
    };
  }
  if (token && !token.isSemantic && activeRules.includes("prefer-semantic-tokens")) {
    return {
      ruleId: "prefer-semantic-tokens",
      severity: "warning",
      message: `${cssVar} is a primitive token; prefer a semantic token for application UI.`,
      match: usage.match,
      provenance: {
        ruleSource: "built-in",
        sourceEntity: token.entity.id,
        sourceEntityPath: token.entity.source.path,
      },
    };
  }
  if (token && activeRules.includes("no-deprecated-tokens") && isDeprecated(token.entity)) {
    const replacement = token.entity.data.replacement;
    const replacementCssVar =
      typeof replacement === "string" ? replacementCssVarFor(replacement, tokenIndex) : undefined;
    return {
      ruleId: "no-deprecated-tokens",
      severity: "error",
      message: `${cssVar} is deprecated.`,
      match: usage.match,
      ...(typeof replacement === "string" ? { suggestion: `Use ${replacement} instead.` } : {}),
      ...(replacementCssVar !== undefined
        ? { replaceWith: usage.match.replace(usage.cssVar, replacementCssVar) }
        : {}),
      provenance: {
        ruleSource: "built-in",
        sourceEntity: token.entity.id,
        sourceEntityPath: token.entity.source.path,
      },
    };
  }
  return null;
}

function replacementCssVarFor(replacement: string, tokenIndex: CssTokenIndex): string | undefined {
  const entityId = replacement.startsWith("token:") ? replacement : `token:${replacement}`;
  for (const token of tokenIndex.tokens.values()) {
    if (token.entity.id === entityId) return token.cssVar;
  }
  return undefined;
}

function isDeprecated(entity: Entity): boolean {
  const value = entity.data.deprecated;
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "false";
}

function isTokenLikeCssVar(cssVar: string, tokenStems: ReadonlySet<string>): boolean {
  const stem = cssVarStem(cssVar);
  return stem !== null && tokenStems.has(stem);
}

function cssVarStem(cssVar: string): string | null {
  const lastDash = cssVar.lastIndexOf("-");
  if (lastDash <= 2) return null;
  return cssVar.slice(0, lastDash);
}

function scan(
  code: string,
  re: RegExp,
  make: (match: string, groups: string[]) => Omit<Violation, "line" | "column"> | null,
): Violation[] {
  const out: Violation[] = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const local = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let result = local.exec(line);
    while (result) {
      const violation = make(result[0], result.slice(1));
      if (violation) {
        out.push({
          ...violation,
          line: i + 1,
          column: result.index + 1,
        });
      }
      if (result.index === local.lastIndex) local.lastIndex++;
      result = local.exec(line);
    }
  }
  return out;
}
