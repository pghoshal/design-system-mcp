import { z } from "zod";
import type { Entity } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";

const EntitySummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
});

const EvidenceSchema = z.object({
  kind: z.enum(["source", "relation", "constraint", "match"]),
  message: z.string(),
  entityId: z.string().optional(),
  sourcePath: z.string().optional(),
});

export const ExplainDecisionInput = z.object({
  entityId: z.string().min(1).max(256),
  intent: z.string().min(1).max(512).optional(),
});

export const ExplainDecisionOutput = z.object({
  entity: EntitySummarySchema,
  reasons: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  related: z.array(EntitySummarySchema),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof ExplainDecisionInput, typeof ExplainDecisionOutput> = {
  name: "explain_decision",
  description:
    "Explain why a design-system entity is a suitable decision using deterministic bundle evidence: source path, intent term overlap, constraints, and relations.",
  input: ExplainDecisionInput,
  output: ExplainDecisionOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const entity = bundle.entities.get(args.entityId);
    if (!entity) throw new ToolError("not_found", `unknown id: ${args.entityId}`);

    const reasons = [`${entity.id} is a ${entity.type} entity from ${entity.source.path}.`];
    const evidence: z.infer<typeof EvidenceSchema>[] = [
      {
        kind: "source",
        message: `Loaded from ${entity.source.path}.`,
        entityId: entity.id,
        sourcePath: entity.source.path,
      },
    ];

    if (args.intent) {
      const overlap = matchingTerms(args.intent, entity);
      if (overlap.length > 0) {
        reasons.push(`Matches intent terms: ${overlap.join(", ")}.`);
        evidence.push({
          kind: "match",
          message: `Intent term overlap: ${overlap.join(", ")}.`,
          entityId: entity.id,
          sourcePath: entity.source.path,
        });
      }
    }

    const related = bundle.relations
      .outFor(entity.id)
      .map((rel) => bundle.entities.get(rel.to))
      .filter((candidate): candidate is Entity => candidate !== undefined)
      .slice(0, 12);

    for (const rel of bundle.relations.outFor(entity.id).slice(0, 12)) {
      evidence.push({
        kind: "relation",
        message: `${entity.id} ${rel.type} ${rel.to}.`,
        entityId: rel.to,
        sourcePath: bundle.entities.get(rel.to)?.source.path,
      });
    }

    const constraints = entity.data.constraints;
    if (Array.isArray(constraints)) {
      for (const constraint of constraints.slice(0, 8)) {
        if (!isConstraintLike(constraint)) continue;
        evidence.push({
          kind: "constraint",
          message: `${constraint.severity}: ${constraint.message}`,
          entityId: entity.id,
          sourcePath: entity.source.path,
        });
      }
    }

    return {
      entity: summarize(entity),
      reasons,
      evidence,
      related: related.map(summarize),
      bundleVersion: bundle.version,
    };
  },
};

function matchingTerms(intent: string, entity: Entity): string[] {
  const haystack = `${entity.id} ${entity.summary} ${entity.tags.join(" ")}`.toLowerCase();
  return [
    ...new Set(
      intent
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 2 && haystack.includes(term)),
    ),
  ].sort();
}

function summarize(entity: Entity): z.infer<typeof EntitySummarySchema> {
  return {
    id: entity.id,
    type: entity.type,
    summary: entity.summary,
    tags: entity.tags,
  };
}

function isConstraintLike(value: unknown): value is { severity: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "severity" in value &&
    "message" in value &&
    typeof value.severity === "string" &&
    typeof value.message === "string"
  );
}
