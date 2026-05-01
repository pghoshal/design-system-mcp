import pino from "pino";
import { describe, expect, it } from "vitest";
import { handler } from "../../../src/tools/inspect-coverage.js";
import { LayeredCache } from "../../../src/util/lru.js";

const logger = pino({ level: "silent" });

describe("inspect_coverage", () => {
  it("reports error coverage gaps without duplicate required-empty warnings", async () => {
    const bundle = {
      version: "test",
      schema: {
        types: {
          token: { searchable: ["summary"] },
          component: { searchable: ["summary"] },
          pattern: { searchable: ["summary"] },
          principle: { searchable: ["summary"] },
          voice: { searchable: ["summary"] },
          convention: { searchable: ["summary"] },
        },
      },
      entities: new Map([
        [
          "component:bad",
          {
            id: "component:bad",
            type: "component",
            summary: "Missing import path and unresolved relation.",
            tags: [],
            data: { props: [], examples: [], principles: [], importPath: "" },
            related: ["token:missing"],
            source: { path: "components/Bad/component.json" },
          },
        ],
      ]),
    };
    const ctx = {
      source: { current: () => bundle },
      cache: new LayeredCache(),
      logger,
      requestId: "test",
    };

    const r = await handler.handle({ include_warnings: true }, ctx as never);

    expect(r.ok).toBe(false);
    expect(r.issues.map((issue) => issue.id)).toContain("required-type-empty");
    expect(r.issues.map((issue) => issue.id)).toContain("component-import-missing");
    expect(r.issues.map((issue) => issue.id)).toContain("component-dependencies-empty");
    expect(r.issues.map((issue) => issue.id)).toContain("relation-target-missing");
    expect(
      r.issues.some((issue) => issue.id === "declared-type-empty" && issue.type === "token"),
    ).toBe(false);
  });

  it("reports pattern contract prop requirements that target unknown props", async () => {
    const bundle = {
      version: "test",
      schema: {
        types: {
          token: { searchable: ["summary"] },
          component: { searchable: ["summary"] },
          pattern: { searchable: ["summary"] },
          principle: { searchable: ["summary"] },
          voice: { searchable: ["summary"] },
        },
      },
      entities: new Map([
        [
          "token:color.action.danger",
          {
            id: "token:color.action.danger",
            type: "token",
            summary: "Danger",
            tags: [],
            data: {},
            source: { path: "tokens/semantic.tokens.json" },
          },
        ],
        [
          "principle:clarity",
          {
            id: "principle:clarity",
            type: "principle",
            summary: "Clarity",
            tags: [],
            data: {},
            source: { path: "docs/principles/clarity.md" },
          },
        ],
        [
          "voice:default",
          {
            id: "voice:default",
            type: "voice",
            summary: "Voice",
            tags: [],
            data: {},
            source: { path: "docs/voice-and-tone.md" },
          },
        ],
        [
          "component:button",
          {
            id: "component:button",
            type: "component",
            summary: "Button",
            tags: [],
            data: {
              importPath: "@acme/ui/button",
              dependencies: [{ package: "@acme/ui", type: "runtime" }],
              props: [{ name: "variant", type: "string", required: false }],
              examples: [{ name: "Button", language: "tsx", code: "<Button />" }],
              principles: ["principle:clarity"],
              patterns: ["pattern:confirmation-dialog"],
            },
            source: { path: "components/Button/component.json" },
          },
        ],
        [
          "pattern:confirmation-dialog",
          {
            id: "pattern:confirmation-dialog",
            type: "pattern",
            summary: "Confirmation",
            tags: [],
            data: {
              contract: {
                requiredComponents: ["component:button"],
                propRequirements: [
                  { component: "component:button", prop: "varient", equals: "danger" },
                ],
              },
            },
            source: { path: "docs/patterns/confirmation-dialog.md" },
          },
        ],
      ]),
    };
    const ctx = {
      source: { current: () => bundle },
      cache: new LayeredCache(),
      logger,
      requestId: "test",
    };

    const r = await handler.handle({ include_warnings: true }, ctx as never);

    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "pattern-contract-prop-target-missing",
        entityId: "pattern:confirmation-dialog",
        message: expect.stringContaining("component:button.varient"),
      }),
    );
  });
});
