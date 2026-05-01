import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolHandler } from "../server/types.js";

export const SearchInput = z.object({
  query: z.string().min(1).max(256),
  type: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  offset: z.number().int().min(0).max(1000).default(0),
});

const HitSchema = z.object({
  id: z.string(),
  type: z.string(),
  score: z.number(),
  summary: z.string(),
  tags: z.array(z.string()),
});

export const SearchOutput = z.object({
  hits: z.array(HitSchema),
  total: z.number().int().nonnegative(),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof SearchInput, typeof SearchOutput> = {
  name: "search_design_system",
  description:
    "Full-text search across the design system. Optionally filter by entity type (e.g. 'token', 'principle', 'pattern') or tags. Use this when you don't know an entity's exact id. Pair with get_entity to fetch full content.",
  input: SearchInput,
  output: SearchOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const ttlMs = 5 * 60_000;
    const key = `search:${cacheKey(args)}`;

    return ctx.cache.fetchOrCompute({ bundleVersion: bundle.version }, key, ttlMs, () => {
      const raw = bundle.searchIndex.search(args.query);

      // Filter by type/tags
      const filtered = raw.filter((r) => {
        if (args.type && r.type !== args.type) return false;
        if (args.tags && args.tags.length > 0) {
          const tagsString = (r.tags as string | undefined) ?? "";
          for (const t of args.tags) if (!tagsString.includes(t)) return false;
        }
        return true;
      });

      const total = filtered.length;
      const window = filtered.slice(args.offset, args.offset + args.limit);

      const hits = window.map((r) => {
        const entity = bundle.entities.get(r.id as string);
        const tags = entity?.tags ?? [];
        const summary = entity?.summary ?? "";
        return {
          id: String(r.id),
          type: String(r.type),
          score: Number(r.score),
          summary,
          tags,
        };
      });

      return {
        hits,
        total,
        bundleVersion: bundle.version,
      };
    });
  },
};

function cacheKey(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
}
