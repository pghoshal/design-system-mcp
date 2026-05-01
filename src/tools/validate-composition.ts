import { z } from "zod";
import type {
  ComponentProp,
  Entity,
  ParentChildRule,
  PatternContract,
  PatternPropRequirement,
} from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";

const ComponentUsageSchema = z.object({
  id: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256).optional(),
  parent: z.string().min(1).max(256).optional(),
  slot: z.string().min(1).max(128).optional(),
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
  platform: z.string().min(1).max(64).optional(),
  framework: z.string().min(1).max(64).optional(),
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
        args.components,
        args.tokens,
        args.platform,
        args.framework,
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
    if (def.deprecated) {
      violations.push({
        entityId: entity.id,
        severity: "warning",
        path: `props.${name}`,
        message: `Prop '${name}' on ${entity.id} is deprecated.`,
        ...(def.replacedBy ? { suggestion: `Use '${def.replacedBy}' instead.` } : {}),
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
  components: z.infer<typeof ComponentUsageSchema>[],
  tokenIds: string[],
  platform: string | undefined,
  framework: string | undefined,
  entities: ReadonlyMap<string, Entity>,
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  const contract = pattern.data.contract as PatternContract | undefined;
  if (!contract) return;

  const selectedComponents = new Set(componentIds);
  const componentProps = propsByComponentId(components);
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

  validateComponentOrder(pattern, contract, componentIds, violations);
  validatePropRequirements(pattern, contract.propRequirements, componentProps, violations);
  validateParentChildRules(pattern, contract.parentChildRules, components, violations);
  validatePlatformRequirements(
    pattern,
    contract,
    selectedComponents,
    componentProps,
    selectedTokens,
    platform,
    framework,
    violations,
  );

  // Free-form contract constraints are guidance unless/until they have a
  // machine-checkable predicate. They are exposed through get_entity/get_usage
  // and should not be reported as validation violations by default.
}

function validateComponentOrder(
  pattern: Entity,
  contract: PatternContract,
  componentIds: readonly string[],
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  if (contract.componentOrder.length < 2) return;
  const indexesByComponent = new Map<string, number[]>();
  for (let index = 0; index < componentIds.length; index++) {
    const id = componentIds[index];
    if (id === undefined) continue;
    const indexes = indexesByComponent.get(id) ?? [];
    indexes.push(index);
    indexesByComponent.set(id, indexes);
  }
  for (let i = 0; i < contract.componentOrder.length - 1; i++) {
    const before = contract.componentOrder[i];
    const after = contract.componentOrder[i + 1];
    if (before === undefined || after === undefined) continue;
    const beforeIndexes = indexesByComponent.get(before) ?? [];
    const afterIndexes = indexesByComponent.get(after) ?? [];
    if (beforeIndexes.length === 0 || afterIndexes.length === 0) continue;
    const maxBefore = Math.max(...beforeIndexes);
    const minAfter = Math.min(...afterIndexes);
    if (maxBefore < minAfter) continue;
    violations.push({
      entityId: pattern.id,
      severity: "error",
      path: "components.order",
      message: `${before} must appear before every ${after} for ${pattern.id}.`,
    });
  }
}

function propsByComponentId(
  components: readonly z.infer<typeof ComponentUsageSchema>[],
): ReadonlyMap<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const component of components) {
    const props = out.get(component.id) ?? [];
    props.push(component.props);
    out.set(component.id, props);
  }
  return out;
}

function validatePropRequirements(
  pattern: Entity,
  requirements: readonly PatternPropRequirement[],
  componentProps: ReadonlyMap<string, Record<string, unknown>[]>,
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  for (const requirement of requirements) {
    const propsList = componentProps.get(requirement.component);
    if (!propsList || propsList.length === 0) continue;
    const invalid = propsList.some((props) => {
      const actual = props[requirement.prop];
      return !(requirement.equals !== undefined
        ? actual === requirement.equals
        : requirement.oneOf?.some((allowed) => actual === allowed) === true);
    });
    if (!invalid) continue;
    violations.push({
      entityId: pattern.id,
      severity: requirement.severity,
      path: `components.${requirement.component}.props.${requirement.prop}`,
      message:
        requirement.message ??
        `${pattern.id} requires ${requirement.component}.${requirement.prop} to match the pattern contract.`,
      suggestion: propRequirementSuggestion(requirement),
    });
  }
}

function validateParentChildRules(
  pattern: Entity,
  rules: readonly ParentChildRule[],
  components: readonly z.infer<typeof ComponentUsageSchema>[],
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  for (const rule of rules) {
    const childUsages = components.filter((usage) => usage.id === rule.child);
    const parentUsages = components.filter((usage) => usage.id === rule.parent);
    if (childUsages.length === 0 || parentUsages.length === 0) continue;

    const relationValid =
      rule.relationship === "required"
        ? childUsages.every((child) =>
            parentUsages.some(
              (parent) =>
                child.parent !== undefined &&
                (child.parent === parent.id || child.parent === parent.instanceId),
            ),
          )
        : childUsages.every((child) =>
            parentUsages.every(
              (parent) =>
                child.parent === undefined ||
                (child.parent !== parent.id && child.parent !== parent.instanceId),
            ),
          );
    if (relationValid) continue;
    violations.push({
      entityId: pattern.id,
      severity: rule.severity,
      path: "components.parent",
      message:
        rule.message ??
        (rule.relationship === "required"
          ? `${pattern.id} requires every ${rule.child} to be nested under ${rule.parent}.`
          : `${pattern.id} forbids ${rule.child} under ${rule.parent}.`),
    });
  }
}

function validatePlatformRequirements(
  pattern: Entity,
  contract: PatternContract,
  selectedComponents: ReadonlySet<string>,
  componentProps: ReadonlyMap<string, Record<string, unknown>[]>,
  selectedTokens: ReadonlySet<string>,
  platform: string | undefined,
  framework: string | undefined,
  violations: z.infer<typeof CompositionViolationSchema>[],
): void {
  if (!platform) return;
  const active = contract.platformRequirements.filter((requirement) => {
    if (requirement.platform !== platform) return false;
    return requirement.framework === undefined || requirement.framework === framework;
  });

  for (const requirement of active) {
    const pathPrefix = `platform.${requirement.platform}.${requirement.framework ?? "*"}`;
    for (const id of requirement.requiredComponents) {
      if (selectedComponents.has(id)) continue;
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: `${pathPrefix}.requiredComponents`,
        message: `${pattern.id} on ${platformLabel(requirement)} requires component '${id}'.`,
      });
    }
    for (const id of requirement.forbiddenComponents) {
      if (!selectedComponents.has(id)) continue;
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: `${pathPrefix}.forbiddenComponents`,
        message: `${pattern.id} on ${platformLabel(requirement)} forbids component '${id}'.`,
      });
    }
    for (const id of requirement.requiredTokens) {
      if (selectedTokens.has(id)) continue;
      violations.push({
        entityId: pattern.id,
        severity: "error",
        path: `${pathPrefix}.requiredTokens`,
        message: `${pattern.id} on ${platformLabel(requirement)} requires token '${id}'.`,
      });
    }
    validatePropRequirements(pattern, requirement.propRequirements, componentProps, violations);
  }
}

function propRequirementSuggestion(requirement: PatternPropRequirement): string | undefined {
  if (requirement.equals !== undefined)
    return `Use ${requirement.prop}=${JSON.stringify(requirement.equals)}.`;
  if (requirement.oneOf !== undefined) {
    return `Use one of: ${requirement.oneOf.map((value) => JSON.stringify(value)).join(", ")}.`;
  }
  return undefined;
}

function platformLabel(requirement: { platform: string; framework?: string | undefined }): string {
  return requirement.framework
    ? `${requirement.platform}/${requirement.framework}`
    : requirement.platform;
}
