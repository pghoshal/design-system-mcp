import { z } from "zod";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";

const EntitySummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
});

export const GetRelatedInput = z.object({
  id: z.string().min(1).max(256),
  relation: z.string().max(64).optional(),
  direction: z.enum(["in", "out", "both"]).default("out"),
  limit: z.number().int().min(1).max(200).default(50),
});

export const GetRelatedOutput = z.object({
  related: z.array(
    z.object({
      entity: EntitySummarySchema,
      relation: z.string(),
      direction: z.enum(["in", "out"]),
    }),
  ),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof GetRelatedInput, typeof GetRelatedOutput> = {
  name: "get_related",
  description:
    "Walk one hop from an entity to its related entities. direction='out' (default) follows links from this entity to others; 'in' walks the inverse; 'both' returns both. Optional relation filter.",
  input: GetRelatedInput,
  output: GetRelatedOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    if (!bundle.entities.has(args.id)) throw new ToolError("not_found", `unknown id: ${args.id}`);

    const out: Array<{
      entity: { id: string; type: string; summary: string; tags: string[] };
      relation: string;
      direction: "in" | "out";
    }> = [];

    const wantOut = args.direction === "out" || args.direction === "both";
    const wantIn = args.direction === "in" || args.direction === "both";

    if (wantOut) {
      for (const r of bundle.relations.outFor(args.id)) {
        if (args.relation && r.type !== args.relation) continue;
        const e = bundle.entities.get(r.to);
        if (!e) continue;
        out.push({
          entity: { id: e.id, type: e.type, summary: e.summary, tags: e.tags },
          relation: r.type,
          direction: "out",
        });
      }
    }
    if (wantIn) {
      for (const r of bundle.relations.inFor(args.id)) {
        if (args.relation && r.type !== args.relation) continue;
        const e = bundle.entities.get(r.from);
        if (!e) continue;
        out.push({
          entity: { id: e.id, type: e.type, summary: e.summary, tags: e.tags },
          relation: r.type,
          direction: "in",
        });
      }
    }

    return {
      related: out.slice(0, args.limit),
      bundleVersion: bundle.version,
    };
  },
};
