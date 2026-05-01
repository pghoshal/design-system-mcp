import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../src/source/local.js";
import { SourceManager } from "../../src/source/manager.js";
import { handler as describeHandler } from "../../src/tools/describe-schema.js";
import { handler as getEntityHandler } from "../../src/tools/get-entity.js";
import { handler as getRelatedHandler } from "../../src/tools/get-related.js";
import { handler as getUsageHandler } from "../../src/tools/get-usage.js";
import { handler as listHandler } from "../../src/tools/list-entities.js";
import { handler as recommendCompositionHandler } from "../../src/tools/recommend-composition.js";
import { handler as resolveHandler } from "../../src/tools/resolve-token.js";
import { handler as searchHandler } from "../../src/tools/search-design-system.js";
import { handler as validateCompositionHandler } from "../../src/tools/validate-composition.js";
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
        ["component", "convention", "pattern", "principle", "token", "voice"].sort(),
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

    it("indexes MDX documentation without JSX noise", async () => {
      const r = await searchHandler.handle(
        { query: "Save billing address", type: "convention", limit: 5, offset: 0 },
        ctx(),
      );
      expect(r.hits[0]?.id).toBe("convention:forms");
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

    it("returns a pattern with a machine-checkable contract", async () => {
      const r = await getEntityHandler.handle(
        { id: "pattern:confirmation-dialog", resolve_relations: false },
        ctx(),
      );
      expect(r.entity.data.contract).toMatchObject({
        requiredComponents: ["component:button"],
        requiredTokens: ["token:color.action.danger"],
      });
    });

    it("returns normalized MDX documentation bodies", async () => {
      const r = await getEntityHandler.handle(
        { id: "convention:forms", resolve_relations: true },
        ctx(),
      );
      expect(r.entity.source.path).toBe("docs/conventions/forms.mdx");
      expect(r.entity.data.body).toContain("Keep labels visible.");
      expect(r.entity.data.body).not.toContain("import ");
      expect(r.entity.data.body).not.toContain("DoDont");
      expect(r.entity.data.body).not.toContain("metadata");
      expect(r.entity.data.body).not.toContain("design-systems");
      expect(r.entity.data.body).not.toContain("<DoDont");
      expect((r.related ?? []).map((e) => e.id)).toContain("principle:clarity");
      expect((r.related ?? []).map((e) => e.id)).toContain("component:button");
    });

    it("does not load prompt MDX files", async () => {
      expect(manager.current().prompts.map((prompt) => prompt.name)).toEqual([
        "build_with_design_system",
      ]);
      expect(manager.current().entities.has("prompt:ignored_mdx_prompt")).toBe(false);
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

    it("infers references from explicit entity ids in documentation", async () => {
      const r = await getRelatedHandler.handle(
        { id: "convention:references", relation: "references", direction: "out", limit: 10 },
        ctx(),
      );
      expect(r.related.map((rel) => rel.entity.id).sort()).toEqual([
        "component:button",
        "token:color.action.primary",
      ]);
    });

    it("does not infer references from overlapping or partial ids", async () => {
      const overlapping = await getRelatedHandler.handle(
        { id: "component:button-group", relation: "references", direction: "out", limit: 10 },
        ctx(),
      );
      expect(overlapping.related).toEqual([]);

      const partial = await getRelatedHandler.handle(
        { id: "convention:non-references", relation: "references", direction: "out", limit: 10 },
        ctx(),
      );
      expect(partial.related).toEqual([]);
    });

    it("returns component metadata with props and examples", async () => {
      const r = await getEntityHandler.handle(
        { id: "component:button", resolve_relations: true },
        ctx(),
      );
      expect(r.entity.type).toBe("component");
      expect(r.entity.data.importPath).toBe("@acme/ui/button");
      expect(Array.isArray(r.entity.data.props)).toBe(true);
      expect((r.related ?? []).map((e) => e.id)).toContain("token:color.action.danger");
    });

    it("enriches component props from TypeScript public APIs", async () => {
      const r = await getEntityHandler.handle(
        { id: "component:card", resolve_relations: false },
        ctx(),
      );
      const props = r.entity.data.props as Array<{
        name: string;
        type: string;
        required: boolean;
        values?: string[];
        description?: string;
      }>;
      expect(props.find((prop) => prop.name === "title")).toMatchObject({
        type: "string",
        required: true,
        description: "Short heading shown at the top of the card.",
      });
      expect(props.find((prop) => prop.name === "tone")).toMatchObject({
        type: '"neutral" | "accent" | "danger" | "elevated"',
        required: false,
        values: ["neutral", "accent", "danger", "elevated"],
      });
      expect(props.find((prop) => prop.name === "tone")?.description).toBeUndefined();
      expect(props.some((prop) => prop.name === "helperOnly")).toBe(false);
    });

    it("enriches component examples from Storybook stories", async () => {
      const r = await getEntityHandler.handle(
        { id: "component:card", resolve_relations: false },
        ctx(),
      );
      const examples = r.entity.data.examples as Array<{ name: string; code: string }>;
      const story = examples.find((example) => example.name === "Neutral Card");
      expect(story?.code).toContain('import { Card } from "@acme/ui/card";');
      expect(story?.code).toContain('<Card title="Billing" tone="neutral">Payment details</Card>');
      expect(examples.some((example) => example.name === "Helper Story")).toBe(false);
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

  describe("enterprise composition tools", () => {
    it("get_usage returns canonical snippets and constraints", async () => {
      const r = await getUsageHandler.handle(
        { id: "component:button", language: "tsx", include_constraints: true },
        ctx(),
      );
      expect(r.importPath).toBe("@acme/ui/button");
      expect(r.examples.length).toBeGreaterThan(0);
      expect(r.examples[0]?.code).toMatch(/<Button/);
      expect(r.constraints.map((c) => c.id)).toContain("button-specific-label");
    });

    it("get_usage includes Storybook-derived snippets", async () => {
      const r = await getUsageHandler.handle(
        { id: "component:card", language: "tsx", include_constraints: false },
        ctx(),
      );
      expect(r.examples.some((example) => example.name === "Neutral Card")).toBe(true);
      expect(
        r.examples.some((example) =>
          example.code.includes('<Card title="Delete project?" tone="danger" disabled={true}>'),
        ),
      ).toBe(true);
    });

    it("validate_composition catches missing and invalid props", async () => {
      const r = await validateCompositionHandler.handle(
        {
          pattern: "pattern:confirmation-dialog",
          components: [{ id: "component:button", props: { variant: "ghost" } }],
          tokens: ["token:color.action.danger"],
        },
        ctx(),
      );
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.path === "props.children")).toBe(true);
      expect(r.violations.some((v) => v.path === "props.variant")).toBe(true);
    });

    it("validate_composition uses TypeScript-derived required props", async () => {
      const r = await validateCompositionHandler.handle(
        {
          components: [{ id: "component:card", props: { tone: "elevated" } }],
          tokens: [],
        },
        ctx(),
      );
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.path === "props.title")).toBe(true);
      expect(r.violations.some((v) => v.path === "props.tone")).toBe(false);
    });

    it("validate_composition enforces pattern contract required tokens", async () => {
      const r = await validateCompositionHandler.handle(
        {
          pattern: "pattern:confirmation-dialog",
          components: [
            { id: "component:button", props: { variant: "danger", children: "Delete project" } },
          ],
          tokens: [],
        },
        ctx(),
      );
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.path === "tokens")).toBe(true);
    });

    it("validate_composition passes a complete confirmation-dialog contract", async () => {
      const r = await validateCompositionHandler.handle(
        {
          pattern: "pattern:confirmation-dialog",
          components: [
            { id: "component:button", props: { variant: "danger", children: "Delete project" } },
          ],
          tokens: ["token:color.action.danger"],
        },
        ctx(),
      );
      expect(r.ok).toBe(true);
      expect(r.violations).toEqual([]);
    });

    it("validate_composition rejects non-pattern ids in the pattern field", async () => {
      const r = await validateCompositionHandler.handle(
        {
          pattern: "component:button",
          components: [
            { id: "component:button", props: { variant: "primary", children: "Save changes" } },
          ],
          tokens: [],
        },
        ctx(),
      );
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.entityId === "component:button")).toBe(true);
    });

    it("recommend_composition returns an implementation brief", async () => {
      const r = await recommendCompositionHandler.handle(
        { intent: "delete project confirmation dialog", framework: "react", limit: 5 },
        ctx(),
      );
      expect(r.recommended.components.map((c) => c.id)).toContain("component:button");
      expect(r.recommended.patterns.map((p) => p.id)).toContain("pattern:confirmation-dialog");
      expect(r.recommended.tokens.map((t) => t.id)).toContain("token:color.action.danger");
      expect(r.constraints.map((c) => c.id)).toContain("button-danger-only-destructive");
      expect(r.nextSteps).toContain(
        "Call validate_ui on generated code and repair all error violations.",
      );
    });
  });
});
