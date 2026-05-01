import { z } from "zod";
import type { ToolHandler } from "../server/types.js";

const EntitySummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
});

export const ListEntitiesInput = z.object({
  type: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(200).default(50),
});

export const ListEntitiesOutput = z.object({
  entities: z.array(EntitySummarySchema),
  page: z.number().int().min(1),
  page_size: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof ListEntitiesInput, typeof ListEntitiesOutput> = {
  name: "list_entities",
  description:
    "Browse the catalog of design system entities. Filter by type (e.g. 'token', 'principle') or by tag. Useful when discovering what exists; for semantic search use search_design_system instead.",
  input: ListEntitiesInput,
  output: ListEntitiesOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();

    const all = [...bundle.entities.values()];
    const filtered = all.filter((e) => {
      if (args.type && e.type !== args.type) return false;
      if (args.tag && !e.tags.includes(args.tag)) return false;
      return true;
    });
    filtered.sort((a, b) => a.id.localeCompare(b.id));

    const total = filtered.length;
    const startIdx = (args.page - 1) * args.page_size;
    const window = filtered.slice(startIdx, startIdx + args.page_size);

    return {
      entities: window.map((e) => ({
        id: e.id,
        type: e.type,
        summary: e.summary,
        tags: e.tags,
      })),
      page: args.page,
      page_size: args.page_size,
      total,
      bundleVersion: bundle.version,
    };
  },
};
