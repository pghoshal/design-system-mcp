import { z } from "zod";
import type { ToolHandler } from "../server/types.js";

export const DescribeSchemaInput = z.object({});

export const DescribeSchemaOutput = z.object({
  schemaVersion: z.string(),
  bundleVersion: z.string(),
  types: z.record(
    z.object({
      description: z.string().optional(),
      searchable: z.array(z.string()),
      facets: z.array(z.string()).optional(),
    }),
  ),
  relations: z.record(
    z.object({
      from: z.string(),
      to: z.string(),
      description: z.string().optional(),
    }),
  ),
  totalEntities: z.number().int().nonnegative(),
});

export const handler: ToolHandler<typeof DescribeSchemaInput, typeof DescribeSchemaOutput> = {
  name: "describe_schema",
  description:
    "Return the design system schema: known content types, their searchable fields, and the relations between them. Call this first to learn what types exist before searching or fetching.",
  input: DescribeSchemaInput,
  output: DescribeSchemaOutput,
  async handle(_args, ctx) {
    const bundle = ctx.source.current();
    return {
      schemaVersion: bundle.schemaVersion,
      bundleVersion: bundle.version,
      types: Object.fromEntries(
        Object.entries(bundle.schema.types).map(([k, v]) => [
          k,
          {
            description: v.description,
            searchable: v.searchable,
            facets: v.facets,
          },
        ]),
      ),
      relations: bundle.schema.relations,
      totalEntities: bundle.entities.size,
    };
  },
};
