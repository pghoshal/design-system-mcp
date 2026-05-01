import { z } from "zod";
import { RuleLanguageSchema } from "../bundle/schema.js";
import type { Violation } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";
import { runRegexDetector } from "../validation/regex.js";

const ViolationSchema = z.object({
  ruleId: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  match: z.string().optional(),
});

export const ValidateUiInput = z.object({
  code: z.string().min(0).max(1_000_000),
  language: RuleLanguageSchema.default("tsx"),
  rules: z.array(z.string().min(1).max(64)).default([]),
});

export const ValidateUiOutput = z.object({
  ok: z.boolean(),
  violations: z.array(ViolationSchema),
  ranRules: z.array(z.string()),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof ValidateUiInput, typeof ValidateUiOutput> = {
  name: "validate_ui",
  description:
    "Validate generated UI code against the design system's rules (e.g. no raw hex colors, no off-scale spacing). Returns structured violations with line/column. Pass `rules: []` (default) to run every applicable rule, or a list of rule ids to run a subset.",
  input: ValidateUiInput,
  output: ValidateUiOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const allRules = bundle.rules;

    // If caller asked for specific rules, every requested id must exist.
    if (args.rules.length > 0) {
      const known = new Set(allRules.map((r) => r.id));
      for (const id of args.rules) {
        if (!known.has(id)) {
          throw new ToolError("invalid_input", `unknown rule id: ${id}`);
        }
      }
    }

    const requested = args.rules.length > 0 ? new Set(args.rules) : null;
    const applicable = allRules.filter((r) => {
      if (requested && !requested.has(r.id)) return false;
      return r.appliesTo.includes(args.language);
    });

    const violations: Violation[] = [];
    for (const rule of applicable) {
      if (rule.detector.type === "regex") {
        violations.push(...runRegexDetector(rule, args.code));
      }
    }

    violations.sort((a, b) => {
      const la = a.line ?? 0;
      const lb = b.line ?? 0;
      if (la !== lb) return la - lb;
      return (a.column ?? 0) - (b.column ?? 0);
    });

    const ok = !violations.some((v) => v.severity === "error");

    return {
      ok,
      violations,
      ranRules: applicable.map((r) => r.id),
      bundleVersion: bundle.version,
    };
  },
};
