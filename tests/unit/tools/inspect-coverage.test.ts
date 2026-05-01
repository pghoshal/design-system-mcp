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
            data: { props: [], examples: [], principles: [] },
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
    expect(r.issues.map((issue) => issue.id)).toContain("relation-target-missing");
    expect(
      r.issues.some((issue) => issue.id === "declared-type-empty" && issue.type === "token"),
    ).toBe(false);
  });
});
