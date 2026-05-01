import { z } from "zod";
import type { DesignConstraint, UsageExample } from "../bundle/types.js";
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
