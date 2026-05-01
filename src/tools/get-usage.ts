import { z } from "zod";
import type {
  ComponentDependency,
  DesignConstraint,
  ImportGuidance,
  UsageExample,
} from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";

const UsageExampleOutputSchema = z.object({
  name: z.string(),
  language: z.string(),
  code: z.string(),
  description: z.string().optional(),
});

const ConstraintOutputSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  rationale: z.string().optional(),
});

const ComponentDependencyOutputSchema = z.object({
  package: z.string(),
  version: z.string().optional(),
  type: z.enum(["runtime", "peer", "dev"]),
  reason: z.string().optional(),
});

const ImportGuidanceOutputSchema = z.object({
  named: z.array(z.string()),
  default: z.string().optional(),
  namespace: z.string().optional(),
  sideEffects: z.array(z.string()),
  notes: z.array(z.string()),
});

export const GetUsageInput = z.object({
  id: z.string().min(1).max(256),
  language: z.string().min(1).max(32).optional(),
  include_constraints: z.boolean().default(true),
});

export const GetUsageOutput = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  importPath: z.string().optional(),
  package: z.string().optional(),
  props: z.array(z.record(z.unknown())).optional(),
  dependencies: z.array(ComponentDependencyOutputSchema).optional(),
  importGuidance: ImportGuidanceOutputSchema.optional(),
  examples: z.array(UsageExampleOutputSchema),
  constraints: z.array(ConstraintOutputSchema),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof GetUsageInput, typeof GetUsageOutput> = {
  name: "get_usage",
  description:
    "Return canonical usage examples, import path, props, and constraints for a design-system entity. Use this before generating code so examples come from the source repo, not model memory.",
  input: GetUsageInput,
  output: GetUsageOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const entity = bundle.entities.get(args.id);
    if (!entity) throw new ToolError("not_found", `unknown id: ${args.id}`);

    const data = entity.data;
    const examples = readExamples(data).filter(
      (ex) => !args.language || ex.language === args.language,
    );
    const constraints = args.include_constraints ? readConstraints(data) : [];

    return {
      id: entity.id,
      type: entity.type,
      summary: entity.summary,
      importPath: readString(data, "importPath"),
      package: readString(data, "package"),
      props: readArrayOfRecords(data, "props"),
      dependencies: readDependencies(data),
      importGuidance: readImportGuidance(data),
      examples,
      constraints,
      bundleVersion: bundle.version,
    };
  },
};

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function readDependencies(data: Record<string, unknown>): ComponentDependency[] | undefined {
  const value = data.dependencies;
  return Array.isArray(value) ? (value as ComponentDependency[]) : undefined;
}

function readImportGuidance(data: Record<string, unknown>): ImportGuidance | undefined {
  const value = data.importGuidance;
  if (!value || typeof value !== "object") return undefined;
  return value as ImportGuidance;
}

function readExamples(data: Record<string, unknown>): UsageExample[] {
  const value = data.examples;
  return Array.isArray(value) ? (value as UsageExample[]) : [];
}

function readConstraints(data: Record<string, unknown>): DesignConstraint[] {
  const value = data.constraints;
  return Array.isArray(value) ? (value as DesignConstraint[]) : [];
}

function readArrayOfRecords(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] | undefined {
  const value = data[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined;
}
