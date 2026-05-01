import { z } from "zod";
import type { Bundle, Entity } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";

const REQUIRED_TYPES = ["token", "component", "pattern", "principle", "voice"] as const;

const CoverageIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  entityId: z.string().optional(),
  type: z.string().optional(),
});

export const InspectCoverageInput = z.object({
  include_warnings: z.boolean().default(true),
});

export const InspectCoverageOutput = z.object({
  ok: z.boolean(),
  counts: z.record(z.number().int().nonnegative()),
  issues: z.array(CoverageIssueSchema),
  bundleVersion: z.string(),
});

type CoverageIssue = z.infer<typeof CoverageIssueSchema>;

export const handler: ToolHandler<typeof InspectCoverageInput, typeof InspectCoverageOutput> = {
  name: "inspect_coverage",
  description:
    "Inspect whether the loaded design-system bundle has enough schema/content coverage for deterministic generation. Reports missing core types, empty types, unresolved relations, and component metadata gaps.",
  input: InspectCoverageInput,
  output: InspectCoverageOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const counts = countByType(bundle);
    const issues = [
      ...requiredTypeIssues(bundle, counts),
      ...emptyDeclaredTypeIssues(bundle, counts),
      ...componentIssues(bundle),
      ...patternIssues(bundle),
      ...relationIssues(bundle),
    ];
    const filtered = args.include_warnings
      ? issues
      : issues.filter((issue) => issue.severity === "error");
    return {
      ok: !issues.some((issue) => issue.severity === "error"),
      counts,
      issues: filtered,
      bundleVersion: bundle.version,
    };
  },
};

function countByType(bundle: Bundle): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of Object.keys(bundle.schema.types)) counts[type] = 0;
  for (const entity of bundle.entities.values()) {
    counts[entity.type] = (counts[entity.type] ?? 0) + 1;
  }
  return counts;
}

function requiredTypeIssues(bundle: Bundle, counts: Record<string, number>): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const type of REQUIRED_TYPES) {
    if (!bundle.schema.types[type]) {
      issues.push({
        id: "required-type-missing-from-schema",
        severity: "error",
        type,
        message: `Required type '${type}' is missing from manifest schema.`,
      });
    } else if ((counts[type] ?? 0) === 0) {
      issues.push({
        id: "required-type-empty",
        severity: "error",
        type,
        message: `Required type '${type}' has no loaded entities.`,
      });
    }
  }
  return issues;
}

function emptyDeclaredTypeIssues(bundle: Bundle, counts: Record<string, number>): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  const required = new Set<string>(REQUIRED_TYPES);
  for (const type of Object.keys(bundle.schema.types)) {
    if (required.has(type)) continue;
    if ((counts[type] ?? 0) === 0) {
      issues.push({
        id: "declared-type-empty",
        severity: "warning",
        type,
        message: `Declared type '${type}' has no loaded entities.`,
      });
    }
  }
  return issues;
}

function componentIssues(bundle: Bundle): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const entity of bundle.entities.values()) {
    if (entity.type !== "component") continue;
    const data = entity.data;
    if (!hasNonEmptyString(data.importPath)) {
      issues.push(
        issue("component-import-missing", "error", entity, "Component is missing importPath."),
      );
    }
    if (!Array.isArray(data.dependencies) || data.dependencies.length === 0) {
      issues.push(
        issue(
          "component-dependencies-empty",
          "warning",
          entity,
          "Component has no package dependency guidance.",
        ),
      );
    }
    if (!Array.isArray(data.props) || data.props.length === 0) {
      issues.push(
        issue("component-props-empty", "warning", entity, "Component has no prop metadata."),
      );
    }
    if (!Array.isArray(data.examples) || data.examples.length === 0) {
      issues.push(
        issue("component-examples-empty", "warning", entity, "Component has no usage examples."),
      );
    }
    if (!Array.isArray(data.principles) || data.principles.length === 0) {
      issues.push(
        issue(
          "component-principles-empty",
          "warning",
          entity,
          "Component has no linked principles.",
        ),
      );
    }
    if (!Array.isArray(data.patterns) || data.patterns.length === 0) {
      issues.push(
        issue(
          "component-orphan",
          "warning",
          entity,
          "Component is not linked to any pattern, so composition recommendations may miss intended usage.",
        ),
      );
    }
  }
  return issues;
}

function patternIssues(bundle: Bundle): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const entity of bundle.entities.values()) {
    if (entity.type !== "pattern") continue;
    const contract = entity.data.contract as
      | {
          requiredComponents?: string[] | undefined;
          optionalComponents?: string[] | undefined;
          forbiddenComponents?: string[] | undefined;
          requiredTokens?: string[] | undefined;
          requiredPrinciples?: string[] | undefined;
        }
      | undefined;
    if (!contract) {
      issues.push(
        issue(
          "pattern-contract-missing",
          "warning",
          entity,
          "Pattern has no machine-checkable contract for composition validation.",
        ),
      );
      continue;
    }
    for (const id of [
      ...(contract.requiredComponents ?? []),
      ...(contract.optionalComponents ?? []),
      ...(contract.forbiddenComponents ?? []),
      ...(contract.requiredTokens ?? []),
      ...(contract.requiredPrinciples ?? []),
    ]) {
      if (bundle.entities.has(id)) continue;
      issues.push({
        id: "pattern-contract-target-missing",
        severity: "error",
        entityId: entity.id,
        type: entity.type,
        message: `${entity.id} pattern contract references missing entity ${id}.`,
      });
    }
  }
  return issues;
}

function relationIssues(bundle: Bundle): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const entity of bundle.entities.values()) {
    const related = entity.related ?? [];
    for (const target of related) {
      if (bundle.entities.has(target)) continue;
      issues.push({
        id: "relation-target-missing",
        severity: "error",
        entityId: entity.id,
        message: `${entity.id} references missing relation target ${target}.`,
      });
    }
  }
  return issues;
}

function issue(
  id: string,
  severity: CoverageIssue["severity"],
  entity: Entity,
  message: string,
): CoverageIssue {
  return { id, severity, entityId: entity.id, type: entity.type, message };
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
