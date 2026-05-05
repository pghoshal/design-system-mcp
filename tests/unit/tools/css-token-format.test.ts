import pino from "pino";
import { describe, expect, it } from "vitest";
import type { Bundle, Entity } from "../../../src/bundle/types.js";
import { handler as resolveToken } from "../../../src/tools/resolve-token.js";
import { handler as validateUi } from "../../../src/tools/validate-ui.js";
import { LayeredCache } from "../../../src/util/lru.js";

const logger = pino({ level: "silent" });

const slashToken: Entity = {
  id: "token:light/color.color.action.disabled",
  type: "token",
  summary: "Disabled action color",
  tags: ["token", "color", "action", "disabled"],
  data: {
    name: "light/color.color.action.disabled",
    path: ["light/color", "color", "action", "disabled"],
    value: "#D4D6D8",
    original: "{light/color.color.disabled}",
    $type: "color",
  },
  source: { path: "tokens.json" },
};

const datavizToken: Entity = {
  id: "token:dataviz.categorical.one",
  type: "token",
  summary: "Categorical chart series one",
  tags: ["token", "dataviz"],
  data: {
    name: "one",
    path: ["dataviz", "categorical", "one"],
    value: "#185ADB",
    original: "#185ADB",
    $type: "color",
  },
  source: { path: "tokens/data-viz.tokens.json" },
};

const spaceToken: Entity = {
  id: "token:space.4",
  type: "token",
  summary: "Spacing primitive",
  tags: ["token", "space"],
  data: {
    name: "4",
    path: ["space", "4"],
    value: "16px",
    original: "16px",
    $type: "dimension",
  },
  source: { path: "tokens/core.tokens.json" },
};

const grayToken: Entity = {
  id: "token:color.gray.500",
  type: "token",
  summary: "Gray palette primitive",
  tags: ["token", "color"],
  data: {
    name: "500",
    path: ["color", "gray", "500"],
    value: "#6B7280",
    original: "#6B7280",
    $type: "color",
  },
  source: { path: "tokens/core.tokens.json" },
};

const bundle: Bundle = {
  version: "test",
  schemaVersion: "1",
  builtAt: "2026-05-02T00:00:00.000Z",
  sourcePath: "/tmp/design-system",
  entities: new Map([
    [slashToken.id, slashToken],
    [datavizToken.id, datavizToken],
    [spaceToken.id, spaceToken],
    [grayToken.id, grayToken],
  ]),
  schema: { types: {}, relations: {} },
  relations: {} as Bundle["relations"],
  searchIndex: {} as Bundle["searchIndex"],
  tokensResolved: {},
  prompts: [],
  rules: [],
};

const ctx = {
  source: { current: () => bundle },
  cache: new LayeredCache(),
  logger,
  requestId: "test",
} as never;

describe("CSS token formatting across tools", () => {
  it("formats slash-containing token-set paths as valid CSS custom properties", async () => {
    const result = await resolveToken.handle(
      { query: "disabled action light", platform: "css", limit: 5 },
      ctx,
    );

    expect(result.matches[0]).toMatchObject({
      id: "token:light/color.color.action.disabled",
      value: "var(--light_u002f_color-color-action-disabled)",
    });
  });

  it("formats tokens for Flutter consumers", async () => {
    const result = await resolveToken.handle(
      { query: "disabled action light", platform: "flutter", limit: 5 },
      ctx,
    );

    expect(result.matches[0]).toMatchObject({
      id: "token:light/color.color.action.disabled",
      value: "AtlasTokens.lightColor.color.action.disabled",
    });
  });

  it("validates the same sanitized CSS custom property name", async () => {
    const result = await validateUi.handle(
      {
        code: ".button { color: var(--light_u002f_color-color-action-disabled); }",
        language: "css",
        rules: ["no-unknown-css-vars", "prefer-semantic-tokens"],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("does not classify enterprise role tokens as primitives just because their value is raw", async () => {
    const result = await validateUi.handle(
      {
        code: [
          ".chart {",
          "  color: var(--dataviz-categorical-one);",
          "  padding: var(--space-4);",
          "}",
        ].join("\n"),
        language: "css",
        rules: ["prefer-semantic-tokens"],
      },
      ctx,
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: "prefer-semantic-tokens",
      provenance: { sourceEntity: "token:space.4" },
    });
  });

  it("still treats unknown raw color families as primitive palettes", async () => {
    const result = await validateUi.handle(
      {
        code: ".x { color: var(--color-gray-500); }",
        language: "css",
        rules: ["prefer-semantic-tokens"],
      },
      ctx,
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: "prefer-semantic-tokens",
      provenance: { sourceEntity: "token:color.gray.500" },
    });
  });
});
