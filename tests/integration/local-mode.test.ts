import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../src/source/local.js";
import { SourceManager } from "../../src/source/manager.js";
import { handler as describeHandler } from "../../src/tools/describe-schema.js";
import { handler as getEntityHandler } from "../../src/tools/get-entity.js";
import { handler as listHandler } from "../../src/tools/list-entities.js";
import { handler as resolveHandler } from "../../src/tools/resolve-token.js";
import { handler as searchHandler } from "../../src/tools/search-design-system.js";
import { handler as validateUiHandler } from "../../src/tools/validate-ui.js";
import { ToolError } from "../../src/util/errors.js";
import { LayeredCache } from "../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });

let manager: SourceManager;
let cache: LayeredCache;

function ctx() {
  return {
    source: manager,
    cache,
    logger,
    requestId: "test",
  };
}

beforeAll(async () => {
  cache = new LayeredCache();
  manager = new SourceManager({
    adapter: new LocalSourceAdapter(FIXTURE, logger),
    logger,
    refreshIntervalSec: 60,
  });
  await manager.initial();
}, 30_000);

afterAll(async () => {
  await manager.stop();
});

describe("Phase 1 — local mode integration", () => {
  describe("describe_schema", () => {
    it("returns schema with declared types", async () => {
      const r = await describeHandler.handle({}, ctx());
      expect(Object.keys(r.types).sort()).toEqual(
        ["pattern", "principle", "token", "voice"].sort(),
      );
      expect(r.totalEntities).toBeGreaterThan(20);
      expect(r.bundleVersion).toMatch(/^.+-\d{4}-/);
    });
  });

  describe("search_design_system", () => {
    it("finds tokens for color queries", async () => {
      const r = await searchHandler.handle(
        { query: "primary blue", type: "token", limit: 5, offset: 0 },
        ctx(),
      );
      expect(r.total).toBeGreaterThan(0);
      const ids = r.hits.map((h) => h.id);
      expect(ids).toContain("token:color.action.primary");
    });

    it("finds principles by content", async () => {
      const r = await searchHandler.handle(
        { query: "clarity clever", type: "principle", limit: 5, offset: 0 },
        ctx(),
      );
      expect(r.hits[0]?.id).toBe("principle:clarity");
    });

    it("respects type filter", async () => {
      const r = await searchHandler.handle(
        { query: "primary", type: "principle", limit: 10, offset: 0 },
        ctx(),
      );
      for (const h of r.hits) expect(h.type).toBe("principle");
    });

    it("uses cache on second identical call", async () => {
      const args = { query: "danger", type: "token" as const, limit: 3, offset: 0 };
      const r1 = await searchHandler.handle(args, ctx());
      const r2 = await searchHandler.handle(args, ctx());
      expect(r1).toEqual(r2);
    });
  });

  describe("get_entity", () => {
    it("returns a token entity with resolved value", async () => {
      const r = await getEntityHandler.handle(
        { id: "token:color.action.primary", resolve_relations: false },
        ctx(),
      );
      expect(r.entity.id).toBe("token:color.action.primary");
      expect(r.entity.type).toBe("token");
      expect(r.entity.data.value).toBe("#2563EB");
      expect(r.entity.data.$type).toBe("color");
    });

    it("returns a principle with body", async () => {
      const r = await getEntityHandler.handle(
        { id: "principle:clarity", resolve_relations: false },
        ctx(),
      );
      expect(r.entity.summary).toMatch(/clear, not clever/i);
      expect(typeof r.entity.data.body).toBe("string");
      expect((r.entity.data.body as string).length).toBeGreaterThan(50);
    });

    it("throws not_found on unknown id", async () => {
      await expect(
        getEntityHandler.handle({ id: "token:nope.nope", resolve_relations: false }, ctx()),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it("resolves explicit `related` frontmatter links", async () => {
      const r = await getEntityHandler.handle(
        { id: "pattern:confirmation-dialog", resolve_relations: true },
        ctx(),
      );
      const ids = (r.related ?? []).map((e) => e.id);
      expect(ids).toContain("principle:clarity");
    });
  });

  describe("list_entities", () => {
    it("paginates tokens", async () => {
      const r = await listHandler.handle({ type: "token", page: 1, page_size: 5 }, ctx());
      expect(r.entities.length).toBe(5);
      expect(r.total).toBeGreaterThanOrEqual(20);
      for (const e of r.entities) expect(e.type).toBe("token");
    });

    it("filters by tag", async () => {
      const r = await listHandler.handle({ tag: "principle", page: 1, page_size: 50 }, ctx());
      expect(r.total).toBeGreaterThanOrEqual(2);
      for (const e of r.entities) expect(e.tags).toContain("principle");
    });
  });

  describe("resolve_token", () => {
    it("returns CSS-formatted values for 'primary'", async () => {
      const r = await resolveHandler.handle({ query: "primary", platform: "css", limit: 5 }, ctx());
      expect(r.matches.length).toBeGreaterThan(0);
      const primary = r.matches.find((m) => m.id === "token:color.action.primary");
      expect(primary?.value).toBe("var(--color-action-primary)");
      expect(primary?.rawValue).toBe("#2563EB");
    });

    it("returns iOS-formatted values", async () => {
      const r = await resolveHandler.handle(
        { query: "spacing md", platform: "ios", limit: 5 },
        ctx(),
      );
      const md = r.matches.find((m) => m.id === "token:spacing.md");
      expect(md?.value).toBe("Tokens.spacing.md");
    });
  });

  describe("validate_ui", () => {
    it("loads the no-hex-colors rule from the fixture", async () => {
      const r = await validateUiHandler.handle(
        { code: "const c = '#2563EB';", language: "tsx", rules: [] },
        ctx(),
      );
      expect(r.ranRules).toContain("no-hex-colors");
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.match === "#2563EB")).toBe(true);
    });

    it("clean code passes", async () => {
      const r = await validateUiHandler.handle(
        {
          code: "const c = 'var(--color-action-primary)';",
          language: "tsx",
          rules: [],
        },
        ctx(),
      );
      expect(r.ok).toBe(true);
      expect(r.violations).toEqual([]);
    });
  });
});
