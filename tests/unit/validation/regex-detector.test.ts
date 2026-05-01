import { describe, expect, it } from "vitest";
import type { Rule } from "../../../src/bundle/types.js";
import { runRegexDetector } from "../../../src/validation/regex.js";

const hexRule: Rule = {
  id: "no-hex-colors",
  description: "Hex colors must come from tokens",
  severity: "error",
  appliesTo: ["tsx", "css"],
  detector: {
    type: "regex",
    pattern: "#[0-9a-fA-F]{3,8}\\b",
    message: "Raw hex color {match} — use a color token instead",
  },
};

describe("runRegexDetector", () => {
  it("returns empty for code with no matches", () => {
    expect(runRegexDetector(hexRule, "color: var(--color-primary);")).toEqual([]);
  });

  it("reports a violation with line, column, match", () => {
    const code = "color: #2563EB;";
    const v = runRegexDetector(hexRule, code);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      ruleId: "no-hex-colors",
      severity: "error",
      line: 1,
      match: "#2563EB",
    });
    expect(v[0]?.column).toBeGreaterThan(0);
  });

  it("reports multiple violations on multiple lines", () => {
    const code = ["a: #FFF;", "b: #000;", "c: var(--ok);"].join("\n");
    const v = runRegexDetector(hexRule, code);
    expect(v).toHaveLength(2);
    expect(v[0]?.line).toBe(1);
    expect(v[1]?.line).toBe(2);
  });

  it("reports multiple matches on the same line", () => {
    const v = runRegexDetector(hexRule, "background: linear-gradient(#fff, #000);");
    expect(v).toHaveLength(2);
    expect(v[0]?.line).toBe(1);
    expect(v[1]?.line).toBe(1);
    expect(v[0]?.column).toBeLessThan(v[1]?.column ?? 0);
  });

  it("interpolates {match} into the message", () => {
    const v = runRegexDetector(hexRule, "color: #2563EB;");
    expect(v[0]?.message).toContain("#2563EB");
  });

  it("supports custom regex flags", () => {
    const ruleI: Rule = {
      ...hexRule,
      detector: { type: "regex", pattern: "TODO", flags: "gi", message: "no TODOs" },
    };
    const v = runRegexDetector(ruleI, "// todo: fix\n// TODO: also fix");
    expect(v).toHaveLength(2);
  });
});
