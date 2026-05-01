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
      searchable: ["name", "summary", "tags"],
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

export const RuleLanguageSchema = z.enum(["tsx", "jsx", "ts", "js", "css", "html", "vue"]);

export const RegexDetectorSchema = z.object({
  type: z.literal("regex"),
  pattern: z.string().min(1),
  flags: z.string().optional(),
  message: z.string().min(1),
});

export const RuleSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/i, "id must match [a-zA-Z][a-zA-Z0-9-]*"),
  description: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]).default("warning"),
  appliesTo: z.array(RuleLanguageSchema).min(1),
  detector: z.discriminatedUnion("type", [RegexDetectorSchema]),
});

export type RuleFile = z.infer<typeof RuleSchema>;
