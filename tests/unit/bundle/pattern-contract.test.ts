import { describe, expect, it } from "vitest";
import { PatternContractSchema } from "../../../src/bundle/schema.js";

describe("PatternContractSchema", () => {
  it("rejects ambiguous prop requirements with both equals and oneOf", () => {
    const result = PatternContractSchema.safeParse({
      propRequirements: [
        {
          component: "component:button",
          prop: "variant",
          equals: "danger",
          oneOf: ["danger", "primary"],
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
