import { z } from "zod";

export const TypeDefSchema = z.object({
  description: z.string().optional(),
  searchable: z.array(z.string()).default(["summary", "tags"]),
  facets: z.array(z.string()).optional(),
  idPattern: z.string().optional(),
});

export const RelationDefSchema = z.object({
  from: z.string(),
  to: z.string(),
  description: z.string().optional(),
});

export const SchemaDefinitionSchema = z.object({
  types: z.record(TypeDefSchema),
  relations: z.record(RelationDefSchema).default({}),
});

export const ManifestSchema = z.object({
  schemaVersion: z.string().default("1.0.0"),
  schema: SchemaDefinitionSchema,
});

export type ManifestFile = z.infer<typeof ManifestSchema>;

/**
 * Default schema used when the source repo has no manifest.json.
 * Permissive: covers the common entity types and lets the builder index whatever it finds.
 */
export const DEFAULT_SCHEMA = SchemaDefinitionSchema.parse({
  types: {
    token: {
      description: "Design token (color, spacing, typography, etc.)",
      searchable: ["name", "summary", "tags"],
      facets: ["$type"],
      idPattern: "^token:",
    },
    principle: {
      description: "Design principle",
      searchable: ["title", "summary", "body", "tags"],
      idPattern: "^principle:",
    },
    pattern: {
      description: "Multi-component pattern",
      searchable: ["title", "summary", "body", "tags"],
      idPattern: "^pattern:",
    },
    voice: {
      description: "Voice & tone guideline",
      searchable: ["title", "summary", "body", "tags"],
      idPattern: "^voice:",
    },
    convention: {
      description: "Code convention",
      searchable: ["title", "summary", "body", "tags"],
      idPattern: "^convention:",
    },
    component: {
      description: "UI component",
      searchable: ["name", "summary", "body", "tags"],
      idPattern: "^component:",
    },
  },
  relations: {
    uses_token: { from: "component", to: "token", description: "Component consumes the token" },
    follows_principle: {
      from: "component",
      to: "principle",
      description: "Component should follow the principle",
    },
    composes: { from: "pattern", to: "component", description: "Pattern composes the component" },
    implements_pattern: {
      from: "component",
      to: "pattern",
      description: "Component is suitable for the pattern",
    },
    references: {
      from: "*",
      to: "*",
      description: "Entity text explicitly references another entity id",
    },
  },
});

export const FrontmatterSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    summary: z.string().optional(),
    title: z.string().optional(),
    tags: z.array(z.string()).default([]),
    related: z.array(z.string()).optional(),
  })
  .passthrough();

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export const PromptFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  arguments: z
    .array(
      z.object({
        name: z.string(),
        required: z.boolean().default(false),
        description: z.string().optional(),
      }),
    )
    .default([]),
});
export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;

export const UsageExampleSchema = z.object({
  name: z.string().min(1),
  language: z.string().min(1).max(32),
  code: z.string().min(1).max(50_000),
  description: z.string().optional(),
  state: z.string().min(1).max(128).optional(),
  controls: z.record(z.array(z.string().min(1).max(128))).optional(),
  interactions: z.array(z.string().min(1).max(5_000)).optional(),
});

export const ComponentDependencySchema = z
  .object({
    package: z.string().min(1).max(128),
    version: z.string().min(1).max(64).optional(),
    type: z.enum(["runtime", "peer", "dev"]).default("runtime"),
    reason: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const ImportGuidanceSchema = z
  .object({
    named: z.array(z.string().min(1).max(128)).default([]),
    default: z.string().min(1).max(128).optional(),
    namespace: z.string().min(1).max(128).optional(),
    sideEffects: z.array(z.string().min(1).max(256)).default([]),
    notes: z.array(z.string().min(1).max(1_000)).default([]),
  })
  .strict();

export const ComponentPropSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.string().min(1).max(256),
  required: z.boolean().default(false),
  description: z.string().optional(),
  values: z.array(z.string().min(1).max(128)).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  deprecated: z.boolean().optional(),
  replacedBy: z.string().min(1).max(128).optional(),
  controlled: z.boolean().optional(),
});

export const DesignConstraintSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z][a-z0-9-]*$/i, "id must match [a-zA-Z][a-zA-Z0-9-]*"),
    severity: z.enum(["error", "warning", "info"]).default("warning"),
    message: z.string().min(1).max(2_000),
    rationale: z.string().max(4_000).optional(),
  })
  .strict();

export const ComponentMetadataSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^component:/, "component id must start with component:"),
  type: z.literal("component").default("component"),
  name: z.string().min(1).max(128),
  summary: z.string().min(1).max(1_000),
  package: z.string().min(1).max(128).optional(),
  importPath: z.string().min(1).max(256),
  dependencies: z.array(ComponentDependencySchema).default([]),
  importGuidance: ImportGuidanceSchema.optional(),
  status: z.enum(["stable", "experimental", "deprecated"]).default("stable"),
  tags: z.array(z.string().min(1).max(64)).default([]),
  props: z.array(ComponentPropSchema).default([]),
  examples: z.array(UsageExampleSchema).default([]),
  constraints: z.array(DesignConstraintSchema).default([]),
  tokens: z.array(z.string().min(1).max(256)).default([]),
  principles: z.array(z.string().min(1).max(256)).default([]),
  patterns: z.array(z.string().min(1).max(256)).default([]),
  related: z.array(z.string().min(1).max(256)).default([]),
});

export type ComponentMetadataFile = z.infer<typeof ComponentMetadataSchema>;

export const PatternContractSlotSchema = z
  .object({
    name: z.string().min(1).max(96),
    required: z.boolean().default(false),
    component: z.string().min(1).max(256).optional(),
    description: z.string().max(1_000).optional(),
  })
  .strict();

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);

export const PatternPropRequirementSchema = z
  .object({
    component: z.string().min(1).max(256),
    prop: z.string().min(1).max(128),
    equals: JsonPrimitiveSchema.optional(),
    oneOf: z.array(JsonPrimitiveSchema).min(1).optional(),
    severity: z.enum(["error", "warning", "info"]).default("error"),
    message: z.string().min(1).max(2_000).optional(),
  })
  .strict()
  .refine((value) => (value.equals !== undefined) !== (value.oneOf !== undefined), {
    message: "prop requirement requires exactly one of equals or oneOf",
  });

export const PlatformRequirementSchema = z
  .object({
    platform: z.string().min(1).max(64),
    framework: z.string().min(1).max(64).optional(),
    requiredComponents: z.array(z.string().min(1).max(256)).default([]),
    forbiddenComponents: z.array(z.string().min(1).max(256)).default([]),
    requiredTokens: z.array(z.string().min(1).max(256)).default([]),
    propRequirements: z.array(PatternPropRequirementSchema).default([]),
  })
  .strict();

export const ParentChildRuleSchema = z
  .object({
    parent: z.string().min(1).max(256),
    child: z.string().min(1).max(256),
    relationship: z.enum(["required", "forbidden"]),
    severity: z.enum(["error", "warning", "info"]).default("error"),
    message: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const PatternContractSchema = z
  .object({
    requiredComponents: z.array(z.string().min(1).max(256)).default([]),
    optionalComponents: z.array(z.string().min(1).max(256)).default([]),
    forbiddenComponents: z.array(z.string().min(1).max(256)).default([]),
    requiredTokens: z.array(z.string().min(1).max(256)).default([]),
    requiredPrinciples: z.array(z.string().min(1).max(256)).default([]),
    componentOrder: z.array(z.string().min(1).max(256)).default([]),
    propRequirements: z.array(PatternPropRequirementSchema).default([]),
    platformRequirements: z.array(PlatformRequirementSchema).default([]),
    parentChildRules: z.array(ParentChildRuleSchema).default([]),
    slots: z.array(PatternContractSlotSchema).default([]),
    constraints: z.array(DesignConstraintSchema).default([]),
  })
  .strict();

export type PatternContractFile = z.infer<typeof PatternContractSchema>;

export const RuleLanguageSchema = z.enum(["tsx", "jsx", "ts", "js", "css", "html", "vue"]);

export const RegexDetectorSchema = z.object({
  type: z.literal("regex"),
  pattern: z.string().min(1),
  flags: z.string().optional(),
  message: z.string().min(1),
});

export const JsxPropValueDetectorSchema = z
  .object({
    type: z.literal("jsx-prop-value"),
    component: z.string().min(1).max(128).optional(),
    prop: z.string().min(1).max(128),
    allow: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .optional(),
    disallow: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .optional(),
    message: z.string().min(1),
  })
  .refine((value) => value.allow !== undefined || value.disallow !== undefined, {
    message: "jsx-prop-value requires allow or disallow",
  });

export const RuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/i, "id must match [a-zA-Z][a-zA-Z0-9-]*"),
    description: z.string().min(1),
    severity: z.enum(["error", "warning", "info"]).default("warning"),
    appliesTo: z.array(RuleLanguageSchema).min(1),
    detector: z.union([RegexDetectorSchema, JsxPropValueDetectorSchema]),
  })
  .refine(
    (rule) =>
      rule.detector.type !== "jsx-prop-value" ||
      rule.appliesTo.every((language) => language === "tsx" || language === "jsx"),
    { message: "jsx-prop-value rules may only apply to tsx/jsx languages" },
  );

export type RuleFile = z.infer<typeof RuleSchema>;
