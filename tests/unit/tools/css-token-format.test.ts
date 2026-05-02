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

const bundle: Bundle = {
  version: "test",
  schemaVersion: "1",
  builtAt: "2026-05-02T00:00:00.000Z",
  sourcePath: "/tmp/design-system",
  entities: new Map([[slashToken.id, slashToken]]),
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
});
