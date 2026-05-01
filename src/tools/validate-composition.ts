import { z } from "zod";
import type { ComponentProp, Entity, PatternContract } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";

const ComponentUsageSchema = z.object({
  id: z.string().min(1).max(256),
  props: z.record(z.unknown()).default({}),
});

const CompositionViolationSchema = z.object({
  entityId: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  path: z.string().optional(),
  suggestion: z.string().optional(),
});

export const ValidateCompositionInput = z.object({
  components: z.array(ComponentUsageSchema).min(1).max(50),
  pattern: z.string().min(1).max(256).optional(),
  tokens: z.array(z.string().min(1).max(256)).default([]),
});

export const ValidateCompositionOutput = z.object({
  ok: z.boolean(),
  violations: z.array(CompositionViolationSchema),
  checkedComponents: z.array(z.string()),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<
  typeof ValidateCompositionInput,
  typeof ValidateCompositionOutput
> = {
  name: "validate_composition",
  description:
    "Validate planned component usage before code is written: unknown components, required props, enum prop values, deprecated components, required pattern alignment, and token existence.",
  input: ValidateCompositionInput,
  output: ValidateCompositionOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const violations: z.infer<typeof CompositionViolationSchema>[] = [];

    const patternEntity = args.pattern ? bundle.entities.get(args.pattern) : undefined;
    if (args.pattern && patternEntity?.type !== "pattern") {
      violations.push({
        entityId: args.pattern,
        severity: "error",
        message: `Unknown or non-pattern entity '${args.pattern}'.`,
      });
    }

    for (const token of args.tokens) {
      const entity = bundle.entities.get(token);
      if (!entity || entity.type !== "token") {
        violations.push({
          entityId: token,
          severity: "error",
          message: `Unknown token '${token}'.`,
        });
      }
    }

    for (const usage of args.components) {
      const entity = bundle.entities.get(usage.id);
      if (!entity || entity.type !== "component") {
        violations.push({
          entityId: usage.id,
          severity: "error",
          message: `Unknown component '${usage.id}'.`,
        });
        continue;
      }
      validateComponent(entity, usage.props, args.pattern, violations);
    }

    if (patternEntity?.type === "pattern") {
      validatePatternContract(
        patternEntity,
        args.components.map((c) => c.id),
        args.tokens,
        bundle.entities,
        violations,
      );
    }

    return {
      ok: !violations.some((v) => v.severity === "error"),
      violations,
      checkedComponents: args.components.map((c) => c.id),
      bundleVersion: bundle.version,
    };
  },
};

function validateComponent(
  entity: Entity,
  props: Record<string, unknown>,
  pattern: string | undefined,
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  const data = entity.data as {
    status?: string | undefined;
    props?: ComponentProp[] | undefined;
    patterns?: string[] | undefined;
  };

  if (data.status === "deprecated") {
    violations.push({
      entityId: entity.id,
      severity: "warning",
      message: `${entity.id} is deprecated.`,
    });
  }

  const propDefs = data.props ?? [];
  const propByName = new Map(propDefs.map((p) => [p.name, p]));

  for (const prop of propDefs) {
    if (prop.required && props[prop.name] === undefined) {
      violations.push({
        entityId: entity.id,
        severity: "error",
        path: `props.${prop.name}`,
        message: `Missing required prop '${prop.name}'.`,
      });
    }
  }

  for (const [name, value] of Object.entries(props)) {
    const def = propByName.get(name);
    if (!def) {
      violations.push({
        entityId: entity.id,
        severity: "warning",
        path: `props.${name}`,
        message: `Unknown prop '${name}' for ${entity.id}.`,
      });
      continue;
    }
    if (def.values && typeof value === "string" && !def.values.includes(value)) {
      violations.push({
        entityId: entity.id,
        severity: "error",
        path: `props.${name}`,
        message: `Invalid value '${value}' for prop '${name}'.`,
        suggestion: `Use one of: ${def.values.join(", ")}.`,
      });
    }
  }

  if (pattern && data.patterns && data.patterns.length > 0 && !data.patterns.includes(pattern)) {
    violations.push({
      entityId: entity.id,
      severity: "warning",
      message: `${entity.id} is not declared as suitable for ${pattern}.`,
    });
  }
}

function validatePatternContract(
  pattern: Entity,
  componentIds: string[],
  tokenIds: string[],
  entities: ReadonlyMap<string, Entity>,
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  const contract = pattern.data.contract as PatternContract | undefined;
  if (!contract) return;

  const selectedComponents = new Set(componentIds);
  const selectedTokens = new Set(tokenIds);

  for (const id of contract.requiredComponents) {
    if (!selectedComponents.has(id)) {
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: "components",
        message: `${pattern.id} requires component '${id}'.`,
      });
    }
  }

  for (const id of contract.forbiddenComponents) {
    if (selectedComponents.has(id)) {
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: "components",
        message: `${pattern.id} forbids component '${id}'.`,
      });
    }
  }

  for (const id of contract.requiredTokens) {
    if (!selectedTokens.has(id)) {
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: "tokens",
        message: `${pattern.id} requires token '${id}'.`,
      });
    }
  }

  for (const id of contract.requiredPrinciples) {
    const covered = componentIds.some((componentId) => {
      const component = entities.get(componentId);
      const principles = component?.data.principles;
      return Array.isArray(principles) && principles.includes(id);
    });
    if (!covered) {
      violations.push({
        entityId: pattern.id,
        severity: "warning",
        path: "components",
        message: `${pattern.id} expects selected components to follow principle '${id}'.`,
      });
    }
  }

  for (const slot of contract.slots) {
    if (slot.required && slot.component && !selectedComponents.has(slot.component)) {
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: `slots.${slot.name}`,
        message: `Required slot '${slot.name}' expects component '${slot.component}'.`,
      });
    }
  }

  // Free-form contract constraints are guidance unless/until they have a
  // machine-checkable predicate. They are exposed through get_entity/get_usage
  // and should not be reported as validation violations by default.
}
