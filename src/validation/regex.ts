import type { Rule, Violation } from "../bundle/types.js";

/**
 * Run a single regex-detector rule against source code.
 * Walks line by line so violations carry line/column info usable by IDEs.
 *
 * The rule's `detector.message` may contain the literal `{match}` token,
 * which is replaced with the matched substring per violation.
 */
export function runRegexDetector(rule: Rule, code: string): Violation[] {
  if (rule.detector.type !== "regex") return [];
  const violations: Violation[] = [];
  const flags = ensureGlobal(rule.detector.flags ?? "g");
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const re = new RegExp(rule.detector.pattern, flags);
    let m: RegExpExecArray | null = re.exec(line);
    while (m !== null) {
      const match = m[0];
      violations.push({
        ruleId: rule.id,
        severity: rule.severity,
        message: rule.detector.message.replace(/\{match\}/g, match),
        line: i + 1,
        column: m.index + 1,
        match,
      });
      // Guard against zero-width matches infinite-looping
      if (m.index === re.lastIndex) re.lastIndex++;
      m = re.exec(line);
    }
  }
  return violations;
}

function ensureGlobal(flags: string): string {
  return flags.includes("g") ? flags : `${flags}g`;
}
