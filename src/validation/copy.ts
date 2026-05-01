import type { Bundle, RuleLanguage, Violation } from "../bundle/types.js";

export const COPY_RULE_IDS = [
  "copy-no-blame",
  "copy-no-hype",
  "copy-no-vague-actions",
  "copy-no-destructive-hedging",
] as const;

const SUPPORTED_LANGUAGES = new Set<RuleLanguage>(["tsx", "jsx", "html", "vue"]);
const BLAME_RE = /\byou\s+(?:forgot|failed|didn't|did not|haven't|have not|must|need to)\b/i;
const HYPE_RE = /(?:!|\boops\b|\bwhoops\b|\bamazing\b|\bawesome\b|\bincredible\b)/i;
const VAGUE_ACTIONS = new Set(["submit", "process", "click here", "ok", "okay", "continue"]);
const DESTRUCTIVE_RE = /\b(?:delete|remove|destroy|archive|discard|deactivate)\b/i;
const HEDGING_RE = /\b(?:maybe|might|probably|possibly|just)\b/i;
const COPY_ATTR_NAMES = [
  "aria-label",
  "title",
  "placeholder",
  "alt",
  "label",
  "text",
  "description",
  "confirmLabel",
  "cancelLabel",
  "actionLabel",
  "primaryLabel",
  "secondaryLabel",
] as const;

interface CopyText {
  text: string;
  line: number;
  column: number;
}

export function runCopyValidation(
  bundle: Bundle,
  code: string,
  language: RuleLanguage,
  selectedRules: ReadonlySet<string> | null,
): { violations: Violation[]; ranRules: string[] } {
  if (!SUPPORTED_LANGUAGES.has(language)) return { violations: [], ranRules: [] };

  const activeRules = COPY_RULE_IDS.filter((id) => !selectedRules || selectedRules.has(id));
  if (activeRules.length === 0) return { violations: [], ranRules: [] };

  const texts = extractCopyText(code);
  const active = new Set<string>(activeRules);
  const violations: Violation[] = [];
  const voice = voiceEntity(bundle);
  const voiceSource = voice ? ` from ${voice.id}` : "";

  for (const text of texts) {
    if (active.has("copy-no-blame") && BLAME_RE.test(text.text)) {
      violations.push(
        violation(
          text,
          "copy-no-blame",
          "error",
          "Copy must not blame the user.",
          `Rewrite in calm, neutral language${voiceSource}.`,
          voice,
        ),
      );
    }
    if (active.has("copy-no-hype") && HYPE_RE.test(text.text)) {
      violations.push(
        violation(
          text,
          "copy-no-hype",
          "warning",
          "Copy should stay calm and avoid hype, alarmism, or exclamation marks.",
          `Use plain, understated wording${voiceSource}.`,
          voice,
        ),
      );
    }
    if (active.has("copy-no-vague-actions") && VAGUE_ACTIONS.has(normalize(text.text))) {
      violations.push(
        violation(
          text,
          "copy-no-vague-actions",
          "warning",
          "Action labels should name the action.",
          `Replace vague labels with specific verbs and objects${voiceSource}.`,
          voice,
        ),
      );
    }
    if (
      active.has("copy-no-destructive-hedging") &&
      DESTRUCTIVE_RE.test(text.text) &&
      HEDGING_RE.test(text.text)
    ) {
      violations.push(
        violation(
          text,
          "copy-no-destructive-hedging",
          "warning",
          "Destructive-action copy should be direct, not hedged.",
          `Name the destructive action and outcome directly${voiceSource}.`,
          voice,
        ),
      );
    }
  }

  return { violations, ranRules: activeRules };
}

function extractCopyText(code: string): CopyText[] {
  const out: CopyText[] = [];
  const lineStarts = lineStartOffsets(code);
  const attrRe = copyAttributeRegex();
  collectMatches(code, lineStarts, attrRe, out);

  const textRe = />\s*([^<>{}][^<>{}]*)\s*</g;
  collectMatches(code, lineStarts, textRe, out);

  return out.filter((item) => item.text.length > 0);
}

function copyAttributeRegex(): RegExp {
  const names = COPY_ATTR_NAMES.map(escapeRegExp).join("|");
  return new RegExp(
    `\\b(?:${names})\\s*=\\s*(?:"([^"]+)"|'([^']+)'|\\{\\s*"([^"]+)"\\s*\\}|\\{\\s*'([^']+)'\\s*\\})`,
    "g",
  );
}

function collectMatches(
  code: string,
  lineStarts: readonly number[],
  re: RegExp,
  out: CopyText[],
): void {
  let result = re.exec(code);
  while (result) {
    const raw = result[1] ?? result[2] ?? result[3] ?? result[4] ?? "";
    const text = normalizeWhitespace(raw);
    const offset = result.index + result[0].indexOf(raw);
    const location = offsetLocation(lineStarts, offset);
    out.push({ text, ...location });
    if (result.index === re.lastIndex) re.lastIndex++;
    result = re.exec(code);
  }
}

function normalize(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[.!?]+$/, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function voiceEntity(bundle: Bundle): { id: string; source: { path: string } } | undefined {
  const voice = Array.from(bundle.entities.values()).find((entity) => entity.type === "voice");
  return voice ? { id: voice.id, source: { path: voice.source.path } } : undefined;
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

function violation(
  text: CopyText,
  ruleId: string,
  severity: Violation["severity"],
  message: string,
  suggestion: string,
  voice?: { id: string; source: { path: string } },
): Violation {
  return {
    ruleId,
    severity,
    message,
    line: text.line,
    column: text.column,
    match: text.text,
    suggestion,
    provenance: {
      ruleSource: "built-in",
      ...(voice !== undefined
        ? { sourceEntity: voice.id, sourceEntityPath: voice.source.path }
        : {}),
    },
  };
}
