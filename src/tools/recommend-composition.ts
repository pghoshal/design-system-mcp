import { z } from "zod";
import type { DesignConstraint, Entity } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";

const EntitySummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
});

const ConstraintOutputSchema = z.object({
  entityId: z.string(),
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
});

const RecommendationProvenanceSchema = z.object({
  entityId: z.string(),
  sourcePath: z.string(),
  reasons: z.array(z.string()),
  relationPath: z.array(z.string()).default([]),
});

export const RecommendCompositionInput = z.object({
  intent: z.string().min(1).max(512),
  platform: z.string().min(1).max(64).optional(),
  framework: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(20).default(12),
});

export const RecommendCompositionOutput = z.object({
  intent: z.string(),
  recommended: z.object({
    components: z.array(EntitySummarySchema),
    patterns: z.array(EntitySummarySchema),
    principles: z.array(EntitySummarySchema),
    tokens: z.array(EntitySummarySchema),
  }),
  alternatives: z.object({
    components: z.array(EntitySummarySchema),
    patterns: z.array(EntitySummarySchema),
    principles: z.array(EntitySummarySchema),
    tokens: z.array(EntitySummarySchema),
  }),
  constraints: z.array(ConstraintOutputSchema),
  provenance: z.array(RecommendationProvenanceSchema),
  nextSteps: z.array(z.string()),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<
  typeof RecommendCompositionInput,
  typeof RecommendCompositionOutput
> = {
  name: "recommend_composition",
  description:
    "Create a design-system implementation brief for an intent. Returns recommended components, patterns, principles, tokens, constraints, and the next MCP calls a harness should run before coding.",
  input: RecommendCompositionInput,
  output: RecommendCompositionOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const query = [args.intent, args.platform, args.framework].filter(Boolean).join(" ");
    const hits = bundle.searchIndex.search(query).slice(0, args.limit * 4);

    const groups = {
      components: [] as ReturnType<typeof summarize>[],
      patterns: [] as ReturnType<typeof summarize>[],
      principles: [] as ReturnType<typeof summarize>[],
      tokens: [] as ReturnType<typeof summarize>[],
    };
    const alternatives = {
      components: [] as ReturnType<typeof summarize>[],
      patterns: [] as ReturnType<typeof summarize>[],
      principles: [] as ReturnType<typeof summarize>[],
      tokens: [] as ReturnType<typeof summarize>[],
    };
    const constraints: z.infer<typeof ConstraintOutputSchema>[] = [];
    const provenance = new Map<string, z.infer<typeof RecommendationProvenanceSchema>>();

    for (const hit of hits) {
      const entity = bundle.entities.get(String(hit.id));
      if (!entity) continue;
      if (entity.type === "component" && groups.components.length < args.limit) {
        groups.components.push(summarize(entity));
        provenance.set(entity.id, provenanceFor(entity, ["Matched the intent search query."]));
        constraints.push(...componentConstraints(entity));
      } else if (entity.type === "pattern" && groups.patterns.length < args.limit) {
        groups.patterns.push(summarize(entity));
        provenance.set(entity.id, provenanceFor(entity, ["Matched the intent search query."]));
      } else if (entity.type === "principle" && groups.principles.length < args.limit) {
        groups.principles.push(summarize(entity));
        provenance.set(entity.id, provenanceFor(entity, ["Matched the intent search query."]));
      } else if (entity.type === "token" && groups.tokens.length < args.limit) {
        groups.tokens.push(summarize(entity));
        provenance.set(entity.id, provenanceFor(entity, ["Matched the intent search query."]));
      }
    }

    const seen = {
      components: new Set(groups.components.map((e) => e.id)),
      patterns: new Set(groups.patterns.map((e) => e.id)),
      principles: new Set(groups.principles.map((e) => e.id)),
      tokens: new Set(groups.tokens.map((e) => e.id)),
    };

    for (const component of groups.components) {
      for (const rel of bundle.relations.outFor(component.id)) {
        const entity = bundle.entities.get(rel.to);
        if (!entity) continue;
        if (rel.type === "uses_token" && entity.type === "token" && !seen.tokens.has(entity.id)) {
          groups.tokens.push(summarize(entity));
          seen.tokens.add(entity.id);
          provenance.set(
            entity.id,
            provenanceFor(
              entity,
              [`Related from ${component.id} via ${rel.type}.`],
              [component.id, entity.id],
            ),
          );
        }
        if (
          rel.type === "follows_principle" &&
          entity.type === "principle" &&
          !seen.principles.has(entity.id)
        ) {
          groups.principles.push(summarize(entity));
          seen.principles.add(entity.id);
          provenance.set(
            entity.id,
            provenanceFor(
              entity,
              [`Related from ${component.id} via ${rel.type}.`],
              [component.id, entity.id],
            ),
          );
        }
        if (
          rel.type === "implements_pattern" &&
          entity.type === "pattern" &&
          !seen.patterns.has(entity.id)
        ) {
          groups.patterns.push(summarize(entity));
          seen.patterns.add(entity.id);
          provenance.set(
            entity.id,
            provenanceFor(
              entity,
              [`Related from ${component.id} via ${rel.type}.`],
              [component.id, entity.id],
            ),
          );
        }
      }
    }

    const selected = new Set([
      ...groups.components.map((entity) => entity.id),
      ...groups.patterns.map((entity) => entity.id),
      ...groups.principles.map((entity) => entity.id),
      ...groups.tokens.map((entity) => entity.id),
    ]);
    fillAlternatives(bundle.entities, selected, alternatives, args.limit);

    return {
      intent: args.intent,
      recommended: groups,
      alternatives,
      constraints,
      provenance: [...provenance.values()],
      nextSteps: [
        "Call get_usage for selected components before writing code.",
        "Call resolve_token for every token value needed in code.",
        "Call validate_composition on the planned components and props.",
        "Call validate_ui on generated code and repair all error violations.",
      ],
      bundleVersion: bundle.version,
    };
  },
};

function summarize(entity: Entity): { id: string; type: string; summary: string; tags: string[] } {
  return {
    id: entity.id,
    type: entity.type,
    summary: entity.summary,
    tags: entity.tags,
  };
}

function componentConstraints(entity: Entity): z.infer<typeof ConstraintOutputSchema>[] {
  const raw = entity.data.constraints;
  if (!Array.isArray(raw)) return [];
  return (raw as DesignConstraint[]).map((c) => ({
    entityId: entity.id,
    id: c.id,
    severity: c.severity,
    message: c.message,
  }));
}

function provenanceFor(
  entity: Entity,
  reasons: string[],
  relationPath: string[] = [],
): z.infer<typeof RecommendationProvenanceSchema> {
  return {
    entityId: entity.id,
    sourcePath: entity.source.path,
    reasons,
    relationPath,
  };
}

function fillAlternatives(
  entities: ReadonlyMap<string, Entity>,
  selected: ReadonlySet<string>,
  alternatives: {
    components: ReturnType<typeof summarize>[];
    patterns: ReturnType<typeof summarize>[];
    principles: ReturnType<typeof summarize>[];
    tokens: ReturnType<typeof summarize>[];
  },
  limit: number,
): void {
  const candidates = [...entities.values()]
    .filter((entity) => !selected.has(entity.id))
    .sort((a, b) => statusRank(a) - statusRank(b) || a.id.localeCompare(b.id));

  for (const entity of candidates) {
    if (entity.type === "component" && alternatives.components.length < limit) {
      alternatives.components.push(summarize(entity));
    } else if (entity.type === "pattern" && alternatives.patterns.length < limit) {
      alternatives.patterns.push(summarize(entity));
    } else if (entity.type === "principle" && alternatives.principles.length < limit) {
      alternatives.principles.push(summarize(entity));
    } else if (entity.type === "token" && alternatives.tokens.length < limit) {
      alternatives.tokens.push(summarize(entity));
    }
  }
}

function statusRank(entity: Entity): number {
  const status = entity.data.status;
  if (status === "stable") return 0;
  if (status === "experimental") return 1;
  if (status === "deprecated") return 2;
  return 0;
}
