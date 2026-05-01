import { z } from "zod";
import type { Entity } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";

const EntitySchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  data: z.record(z.unknown()),
  related: z.array(z.string()).optional(),
  source: z.object({ path: z.string(), line: z.number().int().nonnegative().optional() }),
});

export const GetEntityInput = z.object({
  id: z.string().min(1).max(256),
  resolve_relations: z.boolean().default(false),
});

export const GetEntityOutput = z.object({
  entity: EntitySchema,
  related: z.array(EntitySchema).optional(),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof GetEntityInput, typeof GetEntityOutput> = {
  name: "get_entity",
  description:
    "Fetch a single design system entity by id (e.g. 'token:color.primary.500', 'principle:clarity'). Set resolve_relations=true to also return entities this one points to.",
  input: GetEntityInput,
  output: GetEntityOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const entity = bundle.entities.get(args.id);
    if (!entity) throw new ToolError("not_found", `unknown id: ${args.id}`);

    let related: Entity[] | undefined;
    if (args.resolve_relations) {
      const out = bundle.relations.outFor(args.id);
      const seen = new Set<string>();
      related = [];
      for (const r of out) {
        if (seen.has(r.to)) continue;
        seen.add(r.to);
        const target = bundle.entities.get(r.to);
        if (target) related.push(target);
      }
      if (entity.related) {
        for (const r of entity.related) {
          if (seen.has(r)) continue;
          seen.add(r);
          const target = bundle.entities.get(r);
          if (target) related.push(target);
        }
      }
    }

    return {
      entity: serializeEntity(entity),
      related: related?.map(serializeEntity),
      bundleVersion: bundle.version,
    };
  },
};

function serializeEntity(e: Entity): z.infer<typeof EntitySchema> {
  return {
    id: e.id,
    type: e.type,
    summary: e.summary,
    tags: e.tags,
    data: e.data,
    related: e.related,
    source: e.source,
  };
}
