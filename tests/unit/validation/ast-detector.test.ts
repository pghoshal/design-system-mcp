import { describe, expect, it } from "vitest";
import type { Rule } from "../../../src/bundle/types.js";
import { runAstDetector } from "../../../src/validation/ast.js";

const disallowGhostRule: Rule = {
  id: "no-button-ghost-variant",
  description: "no ghost button variant",
  severity: "error",
  appliesTo: ["tsx"],
  detector: {
    type: "jsx-prop-value",
    component: "Button",
    prop: "variant",
    disallow: ["ghost"],
    message: "Button variant '{value}' is not allowed.",
  },
};

const allowButtonVariantsRule: Rule = {
  id: "button-variant-allowlist",
  description: "button variants must be known",
  severity: "error",
  appliesTo: ["tsx"],
  detector: {
    type: "jsx-prop-value",
    component: "Button",
    prop: "variant",
    allow: ["primary", "secondary", "danger"],
    message: "Button variant '{value}' is not allowed.",
  },
};

describe("runAstDetector", () => {
  it("reports disallowed string literal JSX prop values", async () => {
    const violations = await runAstDetector(
      disallowGhostRule,
      '<Button variant="ghost">Save</Button>',
      "tsx",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "no-button-ghost-variant",
      match: 'variant="ghost"',
    });
  });

  it("reports disallowed no-substitution template literal JSX prop values", async () => {
    const violations = await runAstDetector(
      disallowGhostRule,
      "<Button variant={`ghost`}>Save</Button>",
      "tsx",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.match).toBe("variant={`ghost`}");
  });

  it("does not reject dynamic expressions for allow-list rules", async () => {
    const violations = await runAstDetector(
      allowButtonVariantsRule,
      "<Button variant={variant}>Save</Button>",
      "tsx",
    );
    expect(violations).toEqual([]);
  });

  it("reports literal values outside an allow list", async () => {
    const violations = await runAstDetector(
      allowButtonVariantsRule,
      '<Button variant="ghost">Save</Button>',
      "tsx",
    );
    expect(violations).toHaveLength(1);
  });
});
