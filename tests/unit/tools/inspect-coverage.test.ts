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

  it("reports stale component replacement targets", async () => {
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
          "component:legacy",
          {
            id: "component:legacy",
            type: "component",
            summary: "Legacy",
            tags: [],
            data: {
              status: "deprecated",
              replacedBy: ["component:missing", "token:color.action.danger", "component:old"],
              importPath: "@acme/legacy",
              dependencies: [{ package: "@acme/legacy", type: "runtime" }],
              props: [{ name: "label", type: "string", required: false }],
              examples: [{ name: "Legacy", language: "tsx", code: "<Legacy />" }],
              principles: ["principle:clarity"],
              patterns: [],
            },
            source: { path: "components/Legacy/component.json" },
          },
        ],
        [
          "component:old",
          {
            id: "component:old",
            type: "component",
            summary: "Old replacement",
            tags: [],
            data: {
              status: "deprecated",
              importPath: "@acme/old",
              dependencies: [{ package: "@acme/old", type: "runtime" }],
              props: [{ name: "label", type: "string", required: false }],
              examples: [{ name: "Old", language: "tsx", code: "<Old />" }],
              principles: ["principle:clarity"],
              patterns: ["pattern:confirmation-dialog"],
            },
            source: { path: "components/Old/component.json" },
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
        id: "component-replacement-target-missing",
        entityId: "component:legacy",
        message:
          "component:legacy replacement target component:missing is not an active component.",
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "component-replacement-target-missing",
        entityId: "component:legacy",
        message:
          "component:legacy replacement target token:color.action.danger is not an active component.",
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "component-replacement-target-missing",
        entityId: "component:legacy",
        message: "component:legacy replacement target component:old is not an active component.",
      }),
    );
  });

  it("reports unused tokens and deprecated token references", async () => {
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
          "token:color.used",
          {
            id: "token:color.used",
            type: "token",
            summary: "Used token",
            tags: [],
            data: {},
            source: { path: "tokens/semantic.tokens.json" },
          },
        ],
        [
          "token:color.deprecated",
          {
            id: "token:color.deprecated",
            type: "token",
            summary: "Deprecated token",
            tags: [],
            data: { deprecated: true, replacement: "token:color.used" },
            source: { path: "tokens/semantic.tokens.json" },
          },
        ],
        [
          "token:color.unused",
          {
            id: "token:color.unused",
            type: "token",
            summary: "Unused token",
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
              props: [{ name: "label", type: "string", required: false }],
              examples: [{ name: "Button", language: "tsx", code: "<Button />" }],
              constraints: [{ id: "button-label", severity: "error", message: "Use labels." }],
              principles: ["principle:clarity"],
              patterns: ["pattern:confirmation-dialog"],
              tokens: ["token:color.used", "token:color.deprecated"],
            },
            source: { path: "components/Button/component.json" },
          },
        ],
        [
          "pattern:confirmation-dialog",
          {
            id: "pattern:confirmation-dialog",
            type: "pattern",
            summary: "Pattern",
            tags: [],
            data: { contract: { requiredTokens: ["token:color.used"] } },
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
        id: "deprecated-token-referenced",
        severity: "error",
        entityId: "token:color.deprecated",
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "token-unused",
        severity: "warning",
        entityId: "token:color.unused",
      }),
    );
  });

  it("treats token aliases as token usage and reports missing component constraints", async () => {
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
          "token:color.blue.500",
          {
            id: "token:color.blue.500",
            type: "token",
            summary: "Blue",
            tags: [],
            data: { original: "#2563EB" },
            source: { path: "tokens/core.tokens.json" },
          },
        ],
        [
          "token:color.action.primary",
          {
            id: "token:color.action.primary",
            type: "token",
            summary: "Primary",
            tags: [],
            data: { original: "{color.blue.500}" },
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
              props: [{ name: "label", type: "string", required: false }],
              examples: [{ name: "Button", language: "tsx", code: "<Button />" }],
              principles: ["principle:clarity"],
              patterns: ["pattern:confirmation-dialog"],
              tokens: ["token:color.action.primary"],
            },
            source: { path: "components/Button/component.json" },
          },
        ],
        [
          "pattern:confirmation-dialog",
          {
            id: "pattern:confirmation-dialog",
            type: "pattern",
            summary: "Pattern",
            tags: [],
            data: { contract: { requiredTokens: ["token:color.action.primary"] } },
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

    expect(r.issues).not.toContainEqual(
      expect.objectContaining({ id: "token-unused", entityId: "token:color.blue.500" }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "component-constraints-empty",
        severity: "warning",
        entityId: "component:button",
      }),
    );
  });

  it("reports missing token references, stale token replacements, and orphan patterns", async () => {
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
          "token:color.alias",
          {
            id: "token:color.alias",
            type: "token",
            summary: "Alias",
            tags: [],
            data: { original: "{color.missing}" },
            source: { path: "tokens/semantic.tokens.json" },
          },
        ],
        [
          "token:color.deprecated",
          {
            id: "token:color.deprecated",
            type: "token",
            summary: "Deprecated",
            tags: [],
            data: { deprecated: true, replacement: "token:color.missingReplacement" },
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
              props: [{ name: "label", type: "string", required: false }],
              examples: [{ name: "Button", language: "tsx", code: "<Button />" }],
              constraints: [{ id: "button-label", severity: "error", message: "Use labels." }],
              principles: ["principle:clarity"],
              patterns: ["pattern:linked"],
              tokens: ["token:color.alias", "token:color.missingComponent"],
            },
            source: { path: "components/Button/component.json" },
          },
        ],
        [
          "pattern:linked",
          {
            id: "pattern:linked",
            type: "pattern",
            summary: "Linked pattern",
            tags: [],
            data: { contract: {} },
            source: { path: "docs/patterns/linked.md" },
          },
        ],
        [
          "pattern:orphan",
          {
            id: "pattern:orphan",
            type: "pattern",
            summary: "Orphan pattern",
            tags: [],
            data: { contract: {} },
            source: { path: "docs/patterns/orphan.md" },
          },
        ],
        [
          "pattern:related",
          {
            id: "pattern:related",
            type: "pattern",
            summary: "Related pattern",
            tags: [],
            data: { contract: {} },
            source: { path: "docs/patterns/related.md" },
          },
        ],
      ]),
      relations: {
        inFor: (id: string) =>
          id === "pattern:related"
            ? [{ from: "principle:clarity", to: "pattern:related", type: "references" }]
            : [],
      },
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
        id: "component-token-target-missing",
        severity: "error",
        entityId: "component:button",
        message: expect.stringContaining("token:color.missingComponent"),
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "token-reference-target-missing",
        severity: "error",
        entityId: "token:color.alias",
        message: expect.stringContaining("token:color.missing"),
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "token-replacement-target-missing",
        severity: "error",
        entityId: "token:color.deprecated",
        message: expect.stringContaining("token:color.missingReplacement"),
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        id: "pattern-orphan",
        severity: "warning",
        entityId: "pattern:orphan",
      }),
    );
    expect(r.issues).not.toContainEqual(
      expect.objectContaining({
        id: "pattern-orphan",
        entityId: "pattern:related",
      }),
    );
  });

  it("reports component examples with invalid TypeScript or JSX syntax", async () => {
    const brokenExamples = [
      { name: "Broken TS", language: "ts", code: "const answer: number =" },
      { name: "Broken TSX", language: "tsx", code: "<Button>" },
      { name: "Broken JS", language: "js", code: "const answer =" },
      { name: "Broken JSX", language: "jsx", code: "<Button>" },
    ];
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
          "token:color.action.primary",
          {
            id: "token:color.action.primary",
            type: "token",
            summary: "Primary",
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
              props: [{ name: "label", type: "string", required: false }],
              constraints: [{ id: "button-label", severity: "error", message: "Use labels." }],
              examples: brokenExamples,
              principles: ["principle:clarity"],
              patterns: ["pattern:confirmation-dialog"],
              tokens: ["token:color.action.primary"],
            },
            source: { path: "components/Button/component.json" },
          },
        ],
        [
          "pattern:confirmation-dialog",
          {
            id: "pattern:confirmation-dialog",
            type: "pattern",
            summary: "Pattern",
            tags: [],
            data: { contract: { requiredTokens: ["token:color.action.primary"] } },
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
    for (const example of brokenExamples) {
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          id: "component-example-syntax-invalid",
          severity: "error",
          entityId: "component:button",
          message: expect.stringContaining(example.name),
        }),
      );
    }
    expect(r.issues.filter((issue) => issue.id === "component-example-syntax-invalid")).toEqual(
      brokenExamples.map(() =>
        expect.objectContaining({
          id: "component-example-syntax-invalid",
          severity: "error",
          entityId: "component:button",
        }),
      ),
    );
  });
});
