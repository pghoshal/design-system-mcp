import { z } from "zod";
import type { Bundle, Entity, UsageExample } from "../bundle/types.js";
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
      ...(await componentIssues(bundle)),
      ...patternIssues(bundle),
      ...tokenIssues(bundle),
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

async function componentIssues(bundle: Bundle): Promise<CoverageIssue[]> {
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
    } else {
      issues.push(...(await exampleSyntaxIssues(entity, data.examples as UsageExample[])));
    }
    if (!Array.isArray(data.constraints) || data.constraints.length === 0) {
      issues.push(
        issue(
          "component-constraints-empty",
          "warning",
          entity,
          "Component has no machine-readable constraints.",
        ),
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
    if (Array.isArray(data.replacedBy)) {
      for (const target of data.replacedBy) {
        if (typeof target !== "string") continue;
        const replacement = bundle.entities.get(target);
        if (replacement?.type === "component" && replacement.data.status !== "deprecated") continue;
        issues.push({
          id: "component-replacement-target-missing",
          severity: "error",
          entityId: entity.id,
          type: entity.type,
          message: `${entity.id} replacement target ${target} is not an active component.`,
        });
      }
    }
  }
  return issues;
}

async function exampleSyntaxIssues(
  entity: Entity,
  examples: UsageExample[],
): Promise<CoverageIssue[]> {
  const issues: CoverageIssue[] = [];
  const ts = await import("typescript");

  for (const example of examples) {
    if (!["ts", "tsx", "js", "jsx"].includes(example.language)) continue;
    const sourceFile = ts.createSourceFile(
      `example.${example.language}`,
      example.code,
      ts.ScriptTarget.Latest,
      true,
      example.language === "tsx" || example.language === "jsx"
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );
    const diagnostics = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics ?? [];
    if (diagnostics.length === 0) continue;
    const first = diagnostics[0];
    issues.push({
      id: "component-example-syntax-invalid",
      severity: "error",
      entityId: entity.id,
      type: entity.type,
      message: `${entity.id} example '${example.name}' has invalid ${example.language} syntax: ${formatDiagnosticMessage(first?.messageText)}.`,
    });
  }

  return issues;
}

type SourceFileWithParseDiagnostics = {
  parseDiagnostics?: readonly { messageText?: unknown }[];
};

function formatDiagnosticMessage(message: unknown): string {
  if (typeof message === "string" && message.length > 0) return message;
  if (message && typeof message === "object" && "messageText" in message) {
    return formatDiagnosticMessage((message as { messageText?: unknown }).messageText);
  }
  return "parse error";
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
          componentOrder?: string[] | undefined;
          propRequirements?:
            | Array<{ component?: string | undefined; prop?: string | undefined }>
            | undefined;
          platformRequirements?:
            | Array<{
                requiredComponents?: string[] | undefined;
                forbiddenComponents?: string[] | undefined;
                requiredTokens?: string[] | undefined;
                propRequirements?:
                  | Array<{ component?: string | undefined; prop?: string | undefined }>
                  | undefined;
              }>
            | undefined;
          parentChildRules?:
            | Array<{
                parent?: string | undefined;
                child?: string | undefined;
              }>
            | undefined;
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
      ...(contract.componentOrder ?? []),
      ...(contract.propRequirements ?? [])
        .map((requirement) => requirement.component)
        .filter((id): id is string => typeof id === "string"),
      ...(contract.platformRequirements ?? []).flatMap((requirement) => [
        ...(requirement.requiredComponents ?? []),
        ...(requirement.forbiddenComponents ?? []),
        ...(requirement.requiredTokens ?? []),
        ...(requirement.propRequirements ?? [])
          .map((propRequirement) => propRequirement.component)
          .filter((id): id is string => typeof id === "string"),
      ]),
      ...(contract.parentChildRules ?? []).flatMap((rule) =>
        [rule.parent, rule.child].filter((id): id is string => typeof id === "string"),
      ),
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
    for (const requirement of [
      ...(contract.propRequirements ?? []),
      ...(contract.platformRequirements ?? []).flatMap(
        (platformRequirement) => platformRequirement.propRequirements ?? [],
      ),
    ]) {
      if (!requirement.component) continue;
      const component = bundle.entities.get(requirement.component);
      if (!component || component.type !== "component") continue;
      const props = component.data.props;
      const propExists =
        Array.isArray(props) &&
        props.some(
          (prop) =>
            typeof prop === "object" &&
            prop !== null &&
            "name" in prop &&
            prop.name === requirement.prop,
        );
      if (propExists) continue;
      issues.push({
        id: "pattern-contract-prop-target-missing",
        severity: "error",
        entityId: entity.id,
        type: entity.type,
        message: `${entity.id} pattern contract references missing prop ${requirement.component}.${requirement.prop}.`,
      });
    }
  }
  return issues;
}

function tokenIssues(bundle: Bundle): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  const used = referencedTokenIds(bundle);

  for (const entity of bundle.entities.values()) {
    if (entity.type !== "token") continue;
    if (used.has(entity.id) && isDeprecatedToken(entity)) {
      issues.push({
        id: "deprecated-token-referenced",
        severity: "error",
        entityId: entity.id,
        type: entity.type,
        message: `${entity.id} is deprecated but still referenced by component or pattern metadata.`,
      });
      continue;
    }
    if (!used.has(entity.id) && !isDeprecatedToken(entity)) {
      issues.push({
        id: "token-unused",
        severity: "warning",
        entityId: entity.id,
        type: entity.type,
        message: `${entity.id} is not referenced by component metadata or pattern contracts.`,
      });
    }
  }

  return issues;
}

function referencedTokenIds(bundle: Bundle): Set<string> {
  const used = new Set<string>();
  for (const entity of bundle.entities.values()) {
    const data = entity.data;
    if (entity.type === "token") {
      for (const id of tokenReferenceIds(data.original)) used.add(id);
    }
    if (entity.type === "component" && Array.isArray(data.tokens)) {
      for (const id of data.tokens) if (typeof id === "string") used.add(id);
    }
    if (entity.type === "pattern") {
      const contract = data.contract as
        | {
            requiredTokens?: string[] | undefined;
            platformRequirements?: Array<{ requiredTokens?: string[] | undefined }> | undefined;
          }
        | undefined;
      for (const id of contract?.requiredTokens ?? []) used.add(id);
      for (const requirement of contract?.platformRequirements ?? []) {
        for (const id of requirement.requiredTokens ?? []) used.add(id);
      }
    }
  }
  return used;
}

function tokenReferenceIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const refs = value.match(/\{[^}]+\}/g) ?? [];
  return refs.map((ref) => `token:${ref.slice(1, -1)}`);
}

function isDeprecatedToken(entity: Entity): boolean {
  const value = entity.data.deprecated;
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "false";
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
