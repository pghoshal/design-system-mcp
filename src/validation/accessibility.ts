import type { RuleLanguage, Violation } from "../bundle/types.js";

export const ACCESSIBILITY_RULE_IDS = [
  "a11y-img-alt",
  "a11y-button-name",
  "a11y-link-name",
  "a11y-form-control-label",
  "a11y-no-positive-tabindex",
  "a11y-no-autofocus",
] as const;

const SUPPORTED_LANGUAGES = new Set<RuleLanguage>(["tsx", "jsx", "html", "vue"]);
const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);

interface TagMatch {
  name: string;
  attrs: Map<string, string | true>;
  match: string;
  content: string;
  line: number;
  column: number;
}

interface DocumentScan {
  tags: TagMatch[];
  labelledIds: Set<string>;
}

export function runAccessibilityValidation(
  code: string,
  language: RuleLanguage,
  selectedRules: ReadonlySet<string> | null,
): { violations: Violation[]; ranRules: string[] } {
  if (!SUPPORTED_LANGUAGES.has(language)) return { violations: [], ranRules: [] };

  const activeRules = ACCESSIBILITY_RULE_IDS.filter(
    (id) => !selectedRules || selectedRules.has(id),
  );
  if (activeRules.length === 0) return { violations: [], ranRules: [] };

  const active = new Set<string>(activeRules);
  const doc = scanDocument(code);
  const violations: Violation[] = [];

  for (const tag of doc.tags) {
    if (active.has("a11y-img-alt")) {
      const violation = imgAltViolation(tag);
      if (violation) violations.push(violation);
    }
    if (active.has("a11y-button-name")) {
      const violation = buttonNameViolation(tag);
      if (violation) violations.push(violation);
    }
    if (active.has("a11y-link-name")) {
      const violation = linkNameViolation(tag);
      if (violation) violations.push(violation);
    }
    if (active.has("a11y-form-control-label")) {
      const violation = formControlLabelViolation(tag, doc.labelledIds);
      if (violation) violations.push(violation);
    }
    if (active.has("a11y-no-positive-tabindex")) {
      const violation = positiveTabIndexViolation(tag);
      if (violation) violations.push(violation);
    }
    if (active.has("a11y-no-autofocus")) {
      const violation = autofocusViolation(tag);
      if (violation) violations.push(violation);
    }
  }

  return { violations, ranRules: activeRules };
}

function imgAltViolation(tag: TagMatch): Violation | null {
  if (tag.name !== "img") return null;
  if (tag.attrs.has("alt") || hasAccessibleName(tag)) return null;
  return violation(
    tag,
    "a11y-img-alt",
    "error",
    "Images must include alt text or an accessible name.",
    'Add alt text for meaningful images, or alt="" for decorative images.',
  );
}

function buttonNameViolation(tag: TagMatch): Violation | null {
  if (tag.name !== "button") return null;
  if (hasAccessibleName(tag) || hasInlineContent(tag)) return null;
  return violation(
    tag,
    "a11y-button-name",
    "error",
    "Buttons must have an accessible name.",
    "Add visible button text, aria-label, or aria-labelledby.",
  );
}

function linkNameViolation(tag: TagMatch): Violation | null {
  if (tag.name !== "a") return null;
  if (hasAccessibleName(tag) || hasInlineContent(tag)) return null;
  return violation(
    tag,
    "a11y-link-name",
    "error",
    "Links must have an accessible name.",
    "Add visible link text, aria-label, or aria-labelledby.",
  );
}

function formControlLabelViolation(
  tag: TagMatch,
  labelledIds: ReadonlySet<string>,
): Violation | null {
  if (!FORM_CONTROL_TAGS.has(tag.name)) return null;
  if (tag.name === "input" && attrValue(tag, "type") === "hidden") return null;
  const id = attrValue(tag, "id");
  if (hasAccessibleName(tag) || (id !== null && labelledIds.has(id))) return null;
  return violation(
    tag,
    "a11y-form-control-label",
    "error",
    "Form controls must be associated with a label or accessible name.",
    "Add aria-label, aria-labelledby, or an id connected to a label.",
  );
}

function positiveTabIndexViolation(tag: TagMatch): Violation | null {
  const value = attrValue(tag, "tabindex") ?? attrValue(tag, "tabIndex");
  if (!value) return null;
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return violation(
    tag,
    "a11y-no-positive-tabindex",
    "error",
    "Positive tabindex values create fragile keyboard order.",
    'Use tabindex="0" only when needed, and preserve DOM order.',
  );
}

function autofocusViolation(tag: TagMatch): Violation | null {
  if (!tag.attrs.has("autofocus") && !tag.attrs.has("autoFocus")) return null;
  // Deterministic fix: drop the `autofocus` / `autoFocus` attribute. The
  // replacement target is the matched tag with the attribute stripped out.
  const withoutAttr = tag.match
    .replace(/\s*\bautoFocus\s*(?:=\s*(?:\{[^}]*\}|"[^"]*"|'[^']*'))?/g, "")
    .replace(/\s*\bautofocus\s*(?:=\s*(?:"[^"]*"|'[^']*'))?/gi, "");
  return violation(
    tag,
    "a11y-no-autofocus",
    "warning",
    "Autofocus can move keyboard and screen-reader users unexpectedly.",
    "Move focus intentionally after user action or route change.",
    withoutAttr,
  );
}

function scanDocument(code: string): DocumentScan {
  const tags: TagMatch[] = [];
  const labelledIds = new Set<string>();
  const lineStarts = lineStartOffsets(code);
  const re = /<([A-Za-z][\w.:-]*)(\s[^<>]*?)?>/gs;
  let result = re.exec(code);

  while (result) {
    const rawName = result[1] ?? "";
    const name = normalizeTagName(rawName);
    const attrs = parseAttributes(result[2] ?? "");
    const location = offsetLocation(lineStarts, result.index);
    const match = result[0];
    const content = tagContent(code, rawName, result.index + match.length);
    const tag = {
      name,
      attrs,
      match,
      content,
      line: location.line,
      column: location.column,
    };
    tags.push(tag);

    if (name === "label") {
      const labelled = attrValue(tag, "for") ?? attrValue(tag, "htmlFor");
      if (labelled) labelledIds.add(labelled);
    }
    if (result.index === re.lastIndex) re.lastIndex++;
    result = re.exec(code);
  }

  return { tags, labelledIds };
}

function parseAttributes(source: string): Map<string, string | true> {
  const attrs = new Map<string, string | true>();
  const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'=<>`]+)))?/g;
  let result = re.exec(source);
  while (result) {
    const name = result[1] ?? "";
    const value = result[2] ?? result[3] ?? result[4] ?? result[5] ?? true;
    attrs.set(name, typeof value === "string" ? value.trim() : value);
    result = re.exec(source);
  }
  return attrs;
}

function normalizeTagName(name: string): string {
  return name.includes(".") ? name : name.toLowerCase();
}

function hasAccessibleName(tag: TagMatch): boolean {
  return (
    hasNonEmptyAttr(tag, "aria-label") ||
    hasNonEmptyAttr(tag, "aria-labelledby") ||
    hasNonEmptyAttr(tag, "title")
  );
}

function hasInlineContent(tag: TagMatch): boolean {
  if (/^\s*\{[^}\s]+\}/.test(tag.content)) return true;
  const text = tag.content
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .trim();
  return text.length > 0;
}

function hasNonEmptyAttr(tag: TagMatch, name: string): boolean {
  const value = tag.attrs.get(name);
  return typeof value === "string" && value.trim().length > 0;
}

function attrValue(tag: TagMatch, name: string): string | null {
  const value = tag.attrs.get(name);
  if (typeof value !== "string") return null;
  return value.trim().replace(/^["']|["']$/g, "");
}

function lineStartOffsets(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetLocation(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lineIndex = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    const nextStart = lineStarts[i + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < nextStart) {
      lineIndex = i;
      break;
    }
  }
  return {
    line: lineIndex + 1,
    column: offset - (lineStarts[lineIndex] ?? 0) + 1,
  };
}

function tagContent(code: string, rawName: string, from: number): string {
  const close = new RegExp(`</\\s*${escapeRegExp(rawName)}\\s*>`, "i");
  const result = close.exec(code.slice(from));
  if (!result) return "";
  return code.slice(from, from + result.index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function violation(
  tag: TagMatch,
  ruleId: string,
  severity: Violation["severity"],
  message: string,
  suggestion: string,
  replaceWith?: string,
): Violation {
  return {
    ruleId,
    severity,
    message,
    line: tag.line,
    column: tag.column,
    match: tag.match,
    suggestion,
    ...(replaceWith !== undefined ? { replaceWith } : {}),
    provenance: { ruleSource: "built-in" },
  };
}
