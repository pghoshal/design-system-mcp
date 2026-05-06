import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Bundle, Entity } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";
import type { WorkflowAuditEntry, WorkflowAuditStore } from "../server/workflow-audit.js";
import { hashJson, sha256 } from "../util/stable-hash.js";

const SeveritySchema = z.enum(["error", "warning", "info"]);
const ThemeNameSchema = z.enum(["light", "dark", "highContrast"]);

const ContractViolationSchema = z.object({
  ruleId: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  path: z.string().optional(),
  suggestion: z.string().optional(),
  sourceEntity: z.string().optional(),
});

const ContrastPairSchema = z.object({
  foreground: z.string().min(1),
  background: z.string().min(1),
  minimumRatio: z.number().min(1).max(21).default(4.5),
  path: z.string().optional(),
});

const DataVizSchema = z.object({
  seriesTokens: z.array(z.string().min(1)).default([]),
  summary: z.string().optional(),
  requireSummary: z.boolean().default(true),
});

const LayoutSchema = z.object({
  gapTokens: z.array(z.string().min(1)).default([]),
  rawValues: z.array(z.string().min(1)).default([]),
  columns: z.number().int().min(1).max(24).optional(),
  maxColumns: z.number().int().min(1).max(24).default(12),
});

const PackageSchema = z.object({
  package: z.string().min(1),
  version: z.string().optional(),
  component: z.string().min(1).optional(),
  peerDependencies: z.record(z.string()).default({}),
});

const PlatformUsageSchema = z.object({
  platform: z.string().min(1),
  framework: z.string().optional(),
  components: z
    .array(
      z.object({
        id: z.string().min(1),
        package: z.string().optional(),
        importPath: z.string().optional(),
        component: z.string().optional(),
      }),
    )
    .default([]),
});

const VisualRegressionSchema = z.object({
  baseline: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    hash: z.string().optional(),
  }),
  current: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    hash: z.string().optional(),
  }),
  maxDimensionDelta: z.number().int().min(0).default(0),
  requireHashMatch: z.boolean().default(false),
  diffPixels: z.number().int().min(0).optional(),
  maxDiffPixels: z.number().int().min(0).optional(),
  diffRatio: z.number().min(0).max(1).optional(),
  maxDiffRatio: z.number().min(0).max(1).optional(),
});

const ExternalDesignImportSchema = z.object({
  source: z.enum(["figma", "sketch", "markdown", "tokens", "other"]),
  mappedTokens: z.array(z.string()).default([]),
  mappedComponents: z.array(z.string()).default([]),
  unmappedItems: z.array(z.string()).default([]),
});

const ThemeCoverageSchema = z.object({
  themes: z.array(ThemeNameSchema).min(1),
  tokens: z.array(z.string().min(1)).default([]),
  components: z.array(z.string().min(1)).default([]),
});

const RequiredWorkflowToolSchema = z.enum([
  "start_workflow",
  "describe_schema",
  "search_design_system",
  "list_entities",
  "get_entity",
  "get_related",
  "inspect_coverage",
  "recommend_composition",
  "get_usage",
  "get_component_source",
  "resolve_token",
  "validate_composition",
  "validate_ui",
  "explain_decision",
]);

const WorkflowEvidenceSchema = z.object({
  workflowSessionId: z.string().min(1).optional(),
  requiredToolsUsed: z.array(RequiredWorkflowToolSchema).default([]),
  toolResults: z
    .array(
      z.object({
        tool: RequiredWorkflowToolSchema,
        ok: z.boolean(),
        bundleVersion: z.string().min(1),
        resultHash: z.string().min(1),
      }),
    )
    .default([]),
  resourcesRead: z.array(z.string().min(1)).default([]),
  coverageProfile: z.enum(["community", "enterprise"]).default("enterprise"),
  coverageInspected: z.boolean().default(false),
});

const ComponentImplementationModeSchema = z.enum(["imported", "html-adapter"]);

const ComponentSourceEvidenceSchema = z.object({
  mode: ComponentImplementationModeSchema,
  targetPlatform: z.string().min(1),
  targetFramework: z.string().min(1).optional(),
  components: z
    .array(
      z.object({
        id: z.string().min(1),
        sourceChecked: z.boolean().default(false),
        usageChecked: z.boolean().default(false),
        sourceFiles: z.array(z.string().min(1)).default([]),
        imported: z.boolean().default(false),
        package: z.string().optional(),
        importPath: z.string().optional(),
        adapterRationale: z.string().optional(),
        canonicalStructureMirrored: z.boolean().default(false),
      }),
    )
    .default([]),
});

const TokenResolutionEvidenceSchema = z.object({
  resolvedTokens: z
    .array(
      z.object({
        id: z.string().min(1),
        value: z.string().optional(),
      }),
    )
    .default([]),
  cssVariables: z.array(z.string().min(1)).default([]),
});

const DecisionEvidenceSchema = z.object({
  explainedEntities: z.array(z.string().min(1)).default([]),
});

const COMPONENT_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".svelte",
  ".swift",
  ".kt",
  ".java",
  ".dart",
  ".css",
  ".scss",
  ".sass",
]);

export const ValidateDesignContractInput = z.object({
  theme: ThemeNameSchema.optional(),
  workflowEvidence: WorkflowEvidenceSchema,
  componentSourceEvidence: ComponentSourceEvidenceSchema,
  tokenResolutionEvidence: TokenResolutionEvidenceSchema,
  decisionEvidence: DecisionEvidenceSchema,
  contrastPairs: z.array(ContrastPairSchema).default([]),
  themeCoverage: ThemeCoverageSchema.optional(),
  dataViz: DataVizSchema.optional(),
  layout: LayoutSchema.optional(),
  packages: z.array(PackageSchema).default([]),
  platformUsage: PlatformUsageSchema.optional(),
  visualRegression: VisualRegressionSchema.optional(),
  externalDesignImport: ExternalDesignImportSchema.optional(),
});

export const ValidateDesignContractOutput = z.object({
  ok: z.boolean(),
  violations: z.array(ContractViolationSchema),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<
  typeof ValidateDesignContractInput,
  typeof ValidateDesignContractOutput
> = {
  name: "validate_design_contract",
  description:
    "Validate structured design handoff evidence beyond code: theme/mode token use, contrast pairs, data-viz summaries and tokens, layout tokenization, package compatibility, platform component mappings, visual-regression metadata, and external design import coverage.",
  input: ValidateDesignContractInput,
  output: ValidateDesignContractOutput,
  async handle(args, ctx) {
    const input = ValidateDesignContractInput.parse(args);
    const bundle = ctx.source.current();
    const expectedWorkflowHashes = await expectedWorkflowResultHashesForInput(bundle, input);
    const violations: z.infer<typeof ContractViolationSchema>[] = [
      ...(await validateWorkflowEvidence(
        bundle,
        input.workflowEvidence,
        expectedWorkflowHashes,
        ctx.audit,
        input.componentSourceEvidence,
        input.tokenResolutionEvidence,
        input.decisionEvidence,
      )),
      ...(await validateComponentSourceEvidence(
        bundle,
        input.componentSourceEvidence,
        input.decisionEvidence,
      )),
      ...validateTokenResolutionEvidence(bundle.entities, input.tokenResolutionEvidence),
      ...validateDecisionEvidence(bundle.entities, input.decisionEvidence),
      ...validateContrast(bundle.entities, input.contrastPairs),
      ...validateThemeCoverage(bundle.entities, input.themeCoverage),
      ...validateDataViz(bundle.entities, input.dataViz),
      ...validateLayout(bundle.entities, input.layout),
      ...validatePackages(bundle.entities, input.packages),
      ...validatePlatformUsage(bundle.entities, input.platformUsage),
      ...validateVisualRegression(input.visualRegression),
      ...validateExternalImport(bundle.entities, input.externalDesignImport),
    ];
    return {
      ok: !violations.some((violation) => violation.severity === "error"),
      violations,
      bundleVersion: bundle.version,
    };
  },
};

export async function expectedWorkflowResultHashesForInput(
  bundle: Bundle,
  input: {
    componentSourceEvidence: z.infer<typeof ComponentSourceEvidenceSchema>;
    tokenResolutionEvidence: z.infer<typeof TokenResolutionEvidenceSchema>;
    decisionEvidence: z.infer<typeof DecisionEvidenceSchema>;
  },
): Promise<Map<z.infer<typeof RequiredWorkflowToolSchema>, string>> {
  const out = new Map<z.infer<typeof RequiredWorkflowToolSchema>, string>();
  out.set(
    "get_component_source",
    await componentSourceEvidenceHash(bundle, input.componentSourceEvidence),
  );
  out.set("get_usage", componentUsageEvidenceHash(bundle.entities, input.componentSourceEvidence));
  out.set(
    "resolve_token",
    tokenResolutionEvidenceHash(bundle.entities, input.tokenResolutionEvidence),
  );
  out.set("explain_decision", decisionEvidenceHash(bundle, input.decisionEvidence));
  return out;
}

const REQUIRED_FINAL_HANDOFF_TOOLS: readonly z.infer<typeof RequiredWorkflowToolSchema>[] = [
  "start_workflow",
  "describe_schema",
  "search_design_system",
  "list_entities",
  "get_entity",
  "get_related",
  "inspect_coverage",
  "recommend_composition",
  "get_usage",
  "get_component_source",
  "resolve_token",
  "validate_composition",
  "validate_ui",
  "explain_decision",
];

async function validateWorkflowEvidence(
  bundle: Bundle,
  evidence: z.infer<typeof WorkflowEvidenceSchema>,
  expectedHashes: ReadonlyMap<z.infer<typeof RequiredWorkflowToolSchema>, string>,
  audit: WorkflowAuditStore | undefined,
  componentSourceEvidence: z.infer<typeof ComponentSourceEvidenceSchema>,
  tokenResolutionEvidence: z.infer<typeof TokenResolutionEvidenceSchema>,
  decisionEvidence: z.infer<typeof DecisionEvidenceSchema>,
): Promise<z.infer<typeof ContractViolationSchema>[]> {
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  const used = new Set(evidence.requiredToolsUsed);
  const results = new Map(evidence.toolResults.map((entry) => [entry.tool, entry]));
  const auditSession = evidence.workflowSessionId
    ? audit?.get(evidence.workflowSessionId)
    : undefined;
  const auditResults = new Map(auditSession?.entries.map((entry) => [entry.tool, entry]) ?? []);
  const readWorkflow =
    used.has("describe_schema") || evidence.resourcesRead.includes("design://workflow");

  if (audit && !evidence.workflowSessionId) {
    out.push({
      ruleId: "workflow-session-missing",
      severity: "error",
      path: "workflowEvidence.workflowSessionId",
      message: "Final MCP handoff must include the workflowSessionId returned by start_workflow.",
      suggestion: "Call start_workflow first and pass workflowSessionId to every MCP tool call.",
    });
  } else if (audit && !auditSession) {
    out.push({
      ruleId: "workflow-session-not-found",
      severity: "error",
      path: "workflowEvidence.workflowSessionId",
      message: `${evidence.workflowSessionId ?? "<missing>"} is not an active server-side workflow session.`,
    });
  } else if (auditSession && !bundleVersionMatches(auditSession.bundleVersion, bundle.version)) {
    out.push({
      ruleId: "workflow-session-bundle-mismatch",
      severity: "error",
      path: "workflowEvidence.workflowSessionId",
      message: `Workflow session ${auditSession.id} was started for bundle ${auditSession.bundleVersion}, but current bundle is ${bundle.version}.`,
    });
  }

  if (!readWorkflow) {
    out.push({
      ruleId: "workflow-schema-not-read",
      severity: "error",
      path: "workflowEvidence",
      message: "Final handoff must read design://workflow or call describe_schema.",
      suggestion: "Read design://workflow before planning and include it in resourcesRead.",
    });
  }

  for (const tool of REQUIRED_FINAL_HANDOFF_TOOLS) {
    const result = results.get(tool);
    if (!used.has(tool) || !result) {
      out.push({
        ruleId: "workflow-required-tool-missing",
        severity: "error",
        path: "workflowEvidence.requiredToolsUsed",
        message: `Final handoff is missing required MCP tool result evidence: ${tool}.`,
        suggestion: `Call ${tool} and include it in workflowEvidence.requiredToolsUsed and workflowEvidence.toolResults.`,
      });
      continue;
    }
    if (!result.ok) {
      out.push({
        ruleId: "workflow-tool-result-not-ok",
        severity: "error",
        path: "workflowEvidence.toolResults",
        message: `Required MCP tool ${tool} did not produce ok evidence.`,
      });
    }
    if (!bundleVersionMatches(result.bundleVersion, bundle.version)) {
      out.push({
        ruleId: "workflow-tool-bundle-mismatch",
        severity: "error",
        path: "workflowEvidence.toolResults",
        message: `${tool} evidence was produced for bundle ${result.bundleVersion}, but current bundle is ${bundle.version}.`,
      });
    }
    const expectedHash = expectedHashes.get(tool);
    const audited = auditResults.get(tool);
    const hashToVerify = audited?.resultHash ?? expectedHash;
    if (audit && tool !== "start_workflow" && !audited) {
      out.push({
        ruleId: "workflow-tool-not-audited",
        severity: "error",
        path: "workflowEvidence.toolResults",
        message: `${tool} was not recorded in workflow session ${evidence.workflowSessionId}.`,
        suggestion: `Pass workflowSessionId to ${tool} and re-run the tool before final handoff.`,
      });
    }
    if (hashToVerify && result.resultHash !== hashToVerify) {
      out.push({
        ruleId: "workflow-tool-result-hash-mismatch",
        severity: "error",
        path: "workflowEvidence.toolResults",
        message: `${tool} evidence hash does not match the current bundle and submitted contract evidence.`,
        suggestion: `Re-run ${tool} against the current bundle and submit its returned resultHash.`,
      });
    }
  }

  if (auditSession) {
    for (const component of componentSourceEvidence.components) {
      const componentEntity = bundle.entities.get(component.id);
      const canonicalFiles =
        componentEntity && componentEntity.type === "component"
          ? await canonicalComponentSourcePaths(bundle, componentEntity)
          : [];
      if (!hasAuditedComponentSource(auditSession.entries, component.id, canonicalFiles)) {
        out.push({
          ruleId: "workflow-component-source-not-audited",
          severity: "error",
          path: `componentSourceEvidence.components.${component.id}`,
          message: `${component.id} was not specifically recorded by get_component_source in workflow session ${auditSession.id}.`,
          sourceEntity: component.id,
        });
      }
      if (!hasAuditedInput(auditSession.entries, "get_usage", "id", component.id)) {
        out.push({
          ruleId: "workflow-component-usage-not-audited",
          severity: "error",
          path: `componentSourceEvidence.components.${component.id}`,
          message: `${component.id} was not specifically recorded by get_usage in workflow session ${auditSession.id}.`,
          sourceEntity: component.id,
        });
      }
    }
    for (const token of tokenResolutionEvidence.resolvedTokens) {
      if (!hasAuditedTokenResolution(auditSession.entries, token.id)) {
        out.push({
          ruleId: "workflow-token-resolution-not-audited",
          severity: "error",
          path: "tokenResolutionEvidence.resolvedTokens",
          message: `${token.id} was not specifically recorded by resolve_token in workflow session ${auditSession.id}.`,
          sourceEntity: normalizeTokenId(token.id),
        });
      }
    }
    for (const entityId of decisionEvidence.explainedEntities) {
      if (!hasAuditedInput(auditSession.entries, "explain_decision", "entityId", entityId)) {
        out.push({
          ruleId: "workflow-decision-not-audited",
          severity: "error",
          path: "decisionEvidence.explainedEntities",
          message: `${entityId} was not specifically recorded by explain_decision in workflow session ${auditSession.id}.`,
          sourceEntity: entityId,
        });
      }
    }
  }

  if (!evidence.coverageInspected) {
    out.push({
      ruleId: "workflow-coverage-not-inspected",
      severity: "error",
      path: "workflowEvidence.coverageInspected",
      message: "Final handoff must include inspect_coverage evidence.",
      suggestion: 'Call inspect_coverage with profile: "enterprise" before code generation.',
    });
  }
  if (evidence.coverageProfile !== "enterprise") {
    out.push({
      ruleId: "workflow-enterprise-coverage-required",
      severity: "error",
      path: "workflowEvidence.coverageProfile",
      message: "Enterprise final handoff must use inspect_coverage profile enterprise.",
    });
  }

  return out;
}

function bundleVersionMatches(evidenceVersion: string, currentVersion: string): boolean {
  if (evidenceVersion === currentVersion) return true;
  return evidenceVersion.startsWith("nogit-") && currentVersion.startsWith("nogit-");
}

function hasAuditedInput(
  entries: readonly WorkflowAuditEntry[],
  tool: string,
  key: string,
  value: string,
): boolean {
  return entries.some((entry) => {
    if (entry.tool !== tool || !entry.input || typeof entry.input !== "object") return false;
    return (entry.input as Record<string, unknown>)[key] === value;
  });
}

function hasAuditedComponentSource(
  entries: readonly WorkflowAuditEntry[],
  componentId: string,
  canonicalFiles: readonly string[],
): boolean {
  const implementationFiles = canonicalFiles.filter((file) => !file.endsWith("/component.json"));
  return entries.some((entry) => {
    if (!hasInputValue(entry, "get_component_source", "id", componentId)) return false;
    const files = outputArray(entry, "files");
    const returned = new Set(
      files
        .map((file) => (isRecord(file) && typeof file.path === "string" ? file.path : undefined))
        .filter((file): file is string => file !== undefined),
    );
    return implementationFiles.every((file) => returned.has(file));
  });
}

function hasAuditedTokenResolution(
  entries: readonly WorkflowAuditEntry[],
  tokenId: string,
): boolean {
  const normalized = normalizeTokenId(tokenId);
  return entries.some((entry) => {
    if (entry.tool !== "resolve_token") return false;
    return outputArray(entry, "matches").some(
      (match) => isRecord(match) && match.id === normalized,
    );
  });
}

function hasInputValue(
  entry: WorkflowAuditEntry,
  tool: string,
  key: string,
  value: string,
): boolean {
  if (entry.tool !== tool || !isRecord(entry.input)) return false;
  return entry.input[key] === value;
}

function outputArray(entry: WorkflowAuditEntry, key: string): unknown[] {
  if (!isRecord(entry.output)) return [];
  const value = entry.output[key];
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function componentSourceEvidenceHash(
  bundle: Bundle,
  evidence: z.infer<typeof ComponentSourceEvidenceSchema>,
): Promise<string> {
  const components = [];
  for (const component of [...evidence.components].sort((a, b) => a.id.localeCompare(b.id))) {
    const entity = bundle.entities.get(component.id);
    const sourcePaths = entity ? await canonicalComponentSourcePaths(bundle, entity) : [];
    const files = [];
    for (const sourcePath of sourcePaths) {
      const fileHash = await safeRepoFileHash(bundle.sourcePath, sourcePath);
      files.push({ path: sourcePath, sha256: fileHash });
    }
    components.push({
      id: component.id,
      mode: evidence.mode,
      targetPlatform: evidence.targetPlatform,
      targetFramework: evidence.targetFramework,
      files,
    });
  }
  return hashJson({ kind: "get_component_source", components });
}

function componentUsageEvidenceHash(
  entities: ReadonlyMap<string, Entity>,
  evidence: z.infer<typeof ComponentSourceEvidenceSchema>,
): string {
  const components = [...evidence.components]
    .map((component) => entities.get(component.id))
    .filter((entity): entity is Entity => entity?.type === "component")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entity) => ({
      id: entity.id,
      type: entity.type,
      summary: entity.summary,
      package: stringData(entity, "package"),
      importPath: stringData(entity, "importPath"),
      dependencies: entity.data.dependencies,
      importGuidance: entity.data.importGuidance,
      platforms: entity.data.platforms,
      props: entity.data.props,
      examples: entity.data.examples,
      constraints: entity.data.constraints,
      tokens: entity.data.tokens,
    }));
  return hashJson({ kind: "get_usage", components });
}

function tokenResolutionEvidenceHash(
  entities: ReadonlyMap<string, Entity>,
  evidence: z.infer<typeof TokenResolutionEvidenceSchema>,
): string {
  const tokens = [...evidence.resolvedTokens]
    .map((token) => {
      const id = normalizeTokenId(token.id);
      const entity = entities.get(id);
      return {
        id,
        submittedValue: token.value,
        value: entity?.data.value,
        tokenType: entity?.data.tokenType ?? entity?.data.type,
        source: entity?.source.path,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return hashJson({ kind: "resolve_token", tokens });
}

function decisionEvidenceHash(
  bundle: Bundle,
  evidence: z.infer<typeof DecisionEvidenceSchema>,
): string {
  const entities = [...new Set(evidence.explainedEntities)]
    .map((id) => bundle.entities.get(id))
    .filter((entity): entity is Entity => entity !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entity) => ({
      id: entity.id,
      type: entity.type,
      summary: entity.summary,
      tags: entity.tags,
      source: entity.source.path,
      related: bundle.relations
        .outFor(entity.id)
        .map((rel) => ({
          type: rel.type,
          to: rel.to,
          source: bundle.entities.get(rel.to)?.source.path,
        }))
        .sort((a, b) => `${a.type}:${a.to}`.localeCompare(`${b.type}:${b.to}`)),
      constraints: entity.data.constraints,
    }));
  return hashJson({ kind: "explain_decision", entities });
}

async function safeRepoFileHash(repoRoot: string, sourcePath: string): Promise<string | null> {
  const normalized = sourcePath.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.includes("..")) return null;
  try {
    const file = await fs.readFile(path.resolve(repoRoot, normalized));
    return sha256(file);
  } catch {
    return null;
  }
}

function stringData(entity: Entity, key: string): string | undefined {
  const value = entity.data[key];
  return typeof value === "string" ? value : undefined;
}

async function canonicalComponentSourcePaths(bundle: Bundle, entity: Entity): Promise<string[]> {
  const componentDir = path.posix.dirname(entity.source.path);
  const absDir = path.resolve(bundle.sourcePath, componentDir);
  const sourceFiles = [];
  for (const file of await walkFiles(absDir)) {
    const ext = path.extname(file);
    const base = path.basename(file).toLowerCase();
    if (!COMPONENT_SOURCE_EXTENSIONS.has(ext)) continue;
    if (base.includes(".stories.") || /\.(test|spec)\./.test(base)) continue;
    sourceFiles.push(path.relative(bundle.sourcePath, file).replace(/\\/g, "/"));
  }
  return [...new Set([entity.source.path, ...sourceFiles])].sort();
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function validateComponentSourceEvidence(
  bundle: Bundle,
  evidence: z.infer<typeof ComponentSourceEvidenceSchema>,
  decisionEvidence: z.infer<typeof DecisionEvidenceSchema>,
): Promise<z.infer<typeof ContractViolationSchema>[]> {
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  const explained = new Set(decisionEvidence.explainedEntities);

  if (evidence.components.length === 0) {
    out.push({
      ruleId: "component-source-evidence-empty",
      severity: "error",
      path: "componentSourceEvidence.components",
      message: "Final handoff must include component source/usage evidence.",
    });
  }

  for (const selected of evidence.components) {
    const entity = bundle.entities.get(selected.id);
    if (!entity || entity.type !== "component") {
      out.push({
        ruleId: "component-source-component-missing",
        severity: "error",
        path: `componentSourceEvidence.components.${selected.id}`,
        message: `${selected.id} is not a known component.`,
      });
      continue;
    }

    if (!selected.sourceChecked || selected.sourceFiles.length === 0) {
      out.push({
        ruleId: "component-source-not-consulted",
        severity: "error",
        path: `componentSourceEvidence.components.${selected.id}.sourceFiles`,
        message: `${selected.id} must be checked with get_component_source before code generation.`,
        sourceEntity: selected.id,
      });
    }
    if (selected.sourceFiles.length > 0) {
      const componentDir = path.posix.dirname(entity.source.path);
      const canonicalFiles = await canonicalComponentSourcePaths(bundle, entity);
      const declaredFiles = new Set(
        selected.sourceFiles.map((sourceFile) => sourceFile.replace(/\\/g, "/")),
      );
      for (const canonicalFile of canonicalFiles) {
        if (!declaredFiles.has(canonicalFile)) {
          out.push({
            ruleId: "component-source-file-not-from-tool",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.sourceFiles`,
            message: `${selected.id} source evidence is missing ${canonicalFile} from get_component_source output.`,
            sourceEntity: selected.id,
          });
        }
      }
      for (const sourceFile of selected.sourceFiles) {
        const normalized = sourceFile.replace(/\\/g, "/");
        if (path.posix.isAbsolute(normalized) || normalized.includes("..")) {
          out.push({
            ruleId: "component-source-file-invalid",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.sourceFiles`,
            message: `${sourceFile} is not a valid repo-relative component source path.`,
            sourceEntity: selected.id,
          });
          continue;
        }
        if (!(normalized === entity.source.path || normalized.startsWith(`${componentDir}/`))) {
          out.push({
            ruleId: "component-source-file-outside-component",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.sourceFiles`,
            message: `${sourceFile} is outside ${selected.id}'s component source directory.`,
            sourceEntity: selected.id,
          });
          continue;
        }
        const abs = path.resolve(bundle.sourcePath, normalized);
        try {
          const stat = await fs.stat(abs);
          if (!stat.isFile()) {
            out.push({
              ruleId: "component-source-file-missing",
              severity: "error",
              path: `componentSourceEvidence.components.${selected.id}.sourceFiles`,
              message: `${sourceFile} is not a readable component source file.`,
              sourceEntity: selected.id,
            });
          }
        } catch {
          out.push({
            ruleId: "component-source-file-missing",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.sourceFiles`,
            message: `${sourceFile} does not exist in the source repo.`,
            sourceEntity: selected.id,
          });
        }
      }
    }

    if (!selected.usageChecked) {
      out.push({
        ruleId: "component-usage-not-consulted",
        severity: "error",
        path: `componentSourceEvidence.components.${selected.id}.usageChecked`,
        message: `${selected.id} must be checked with get_usage before code generation.`,
        sourceEntity: selected.id,
      });
    }

    if (!explained.has(selected.id)) {
      out.push({
        ruleId: "component-decision-not-explained",
        severity: "error",
        path: "decisionEvidence.explainedEntities",
        message: `${selected.id} must have explain_decision evidence.`,
        sourceEntity: selected.id,
      });
    }

    const mapping = platformMappingFor(entity, evidence.targetPlatform, evidence.targetFramework);

    if (evidence.mode === "imported") {
      if (!selected.imported) {
        out.push({
          ruleId: "component-import-required",
          severity: "error",
          path: `componentSourceEvidence.components.${selected.id}.imported`,
          message: `${selected.id} must be imported because componentSourceEvidence.mode is imported.`,
          sourceEntity: selected.id,
        });
      }
      if (!mapping) {
        out.push({
          ruleId: "component-platform-mapping-missing",
          severity: "error",
          path: `componentSourceEvidence.components.${selected.id}`,
          message: `${selected.id} has no mapping for ${evidence.targetPlatform}/${evidence.targetFramework ?? "*"}.`,
          sourceEntity: selected.id,
        });
      } else {
        if (typeof mapping.package === "string" && !selected.package) {
          out.push({
            ruleId: "component-source-package-required",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.package`,
            message: `${selected.id} must include package ${mapping.package}.`,
            sourceEntity: selected.id,
          });
        }
        if (typeof mapping.importPath === "string" && !selected.importPath) {
          out.push({
            ruleId: "component-source-import-required",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.importPath`,
            message: `${selected.id} must include importPath ${mapping.importPath}.`,
            sourceEntity: selected.id,
          });
        }
        if (selected.package && mapping.package !== selected.package) {
          out.push({
            ruleId: "component-source-package-mismatch",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.package`,
            message: `${selected.id} must use package ${String(mapping.package)}.`,
            sourceEntity: selected.id,
          });
        }
        if (selected.importPath && mapping.importPath !== selected.importPath) {
          out.push({
            ruleId: "component-source-import-mismatch",
            severity: "error",
            path: `componentSourceEvidence.components.${selected.id}.importPath`,
            message: `${selected.id} must use importPath ${String(mapping.importPath)}.`,
            sourceEntity: selected.id,
          });
        }
      }
    } else {
      if (mapping) {
        out.push({
          ruleId: "component-adapter-not-allowed",
          severity: "error",
          path: "componentSourceEvidence.mode",
          message: `${selected.id} has a native ${evidence.targetPlatform}/${evidence.targetFramework ?? "*"} mapping; import the component instead of hand-writing an adapter.`,
          sourceEntity: selected.id,
        });
      }
      if (!selected.canonicalStructureMirrored) {
        out.push({
          ruleId: "component-adapter-structure-unverified",
          severity: "error",
          path: `componentSourceEvidence.components.${selected.id}.canonicalStructureMirrored`,
          message: `${selected.id} HTML adapter must prove it mirrors canonical source structure.`,
          sourceEntity: selected.id,
        });
      }
      if (!selected.adapterRationale?.trim()) {
        out.push({
          ruleId: "component-adapter-rationale-required",
          severity: "error",
          path: `componentSourceEvidence.components.${selected.id}.adapterRationale`,
          message: `${selected.id} HTML adapter must explain why an adapter is necessary.`,
          sourceEntity: selected.id,
        });
      }
    }
  }

  return out;
}

function validateTokenResolutionEvidence(
  entities: ReadonlyMap<string, Entity>,
  evidence: z.infer<typeof TokenResolutionEvidenceSchema>,
): z.infer<typeof ContractViolationSchema>[] {
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  if (evidence.resolvedTokens.length === 0) {
    out.push({
      ruleId: "token-resolution-evidence-empty",
      severity: "error",
      path: "tokenResolutionEvidence.resolvedTokens",
      message: "Final handoff must include resolve_token evidence for used design values.",
    });
  }
  for (const token of evidence.resolvedTokens) {
    const entity = entities.get(normalizeTokenId(token.id));
    if (!entity || entity.type !== "token") {
      out.push({
        ruleId: "token-resolution-token-missing",
        severity: "error",
        path: "tokenResolutionEvidence.resolvedTokens",
        message: `${token.id} is not a known token resolved by MCP.`,
      });
    }
  }
  for (const cssVar of evidence.cssVariables) {
    if (!/^--[A-Za-z0-9_-]+$/.test(cssVar)) {
      out.push({
        ruleId: "token-resolution-css-var-invalid",
        severity: "error",
        path: "tokenResolutionEvidence.cssVariables",
        message: `${cssVar} is not a valid CSS custom property name.`,
      });
    }
  }
  return out;
}

function validateDecisionEvidence(
  entities: ReadonlyMap<string, Entity>,
  evidence: z.infer<typeof DecisionEvidenceSchema>,
): z.infer<typeof ContractViolationSchema>[] {
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  if (evidence.explainedEntities.length === 0) {
    out.push({
      ruleId: "decision-evidence-empty",
      severity: "error",
      path: "decisionEvidence.explainedEntities",
      message: "Final handoff must include explain_decision evidence.",
    });
  }
  for (const entityId of evidence.explainedEntities) {
    if (!entities.has(entityId)) {
      out.push({
        ruleId: "decision-entity-missing",
        severity: "error",
        path: "decisionEvidence.explainedEntities",
        message: `${entityId} is not a known explained entity.`,
      });
    }
  }
  return out;
}

function validateContrast(
  entities: ReadonlyMap<string, Entity>,
  pairs: z.infer<typeof ContrastPairSchema>[],
): z.infer<typeof ContractViolationSchema>[] {
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  for (const [index, pair] of pairs.entries()) {
    const fg = colorFor(entities, pair.foreground);
    const bg = colorFor(entities, pair.background);
    if (!fg || !bg) {
      out.push({
        ruleId: "contrast-token-unresolved",
        severity: "error",
        path: pair.path ?? `contrastPairs.${index}`,
        message: `Could not resolve contrast pair ${pair.foreground} on ${pair.background}.`,
      });
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < pair.minimumRatio) {
      out.push({
        ruleId: "contrast-ratio-too-low",
        severity: "error",
        path: pair.path ?? `contrastPairs.${index}`,
        message: `Contrast ratio ${ratio.toFixed(2)} is below required ${pair.minimumRatio}.`,
        suggestion: "Use a stronger text/surface token pair.",
      });
    }
  }
  return out;
}

function validateThemeCoverage(
  entities: ReadonlyMap<string, Entity>,
  coverage: z.infer<typeof ThemeCoverageSchema> | undefined,
): z.infer<typeof ContractViolationSchema>[] {
  if (!coverage) return [];
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  const required = new Set(coverage.tokens.map(normalizeTokenId));

  for (const componentId of coverage.components) {
    const component = entities.get(componentId);
    if (!component || component.type !== "component") {
      out.push({
        ruleId: "theme-coverage-component-missing",
        severity: "error",
        path: "themeCoverage.components",
        message: `${componentId} is not a known component for theme coverage.`,
      });
      continue;
    }
    for (const token of componentTokens(component)) required.add(token);
  }

  for (const token of required) {
    if (token.startsWith("token:theme.")) continue;
    if (!isThemeSensitiveToken(token)) continue;
    const source = entities.get(token);
    if (!source || source.type !== "token") {
      out.push({
        ruleId: "theme-coverage-token-missing",
        severity: "error",
        path: "themeCoverage.tokens",
        message: `${token} is not a known token for theme coverage.`,
      });
      continue;
    }
    const tokenPath = token.slice("token:".length);
    for (const theme of coverage.themes) {
      const themedToken = `token:theme.${theme}.${tokenPath}`;
      if (!entities.has(themedToken)) {
        out.push({
          ruleId: "theme-token-variant-missing",
          severity: "error",
          path: `themeCoverage.${theme}`,
          message: `${token} is used in a themed handoff but ${themedToken} does not exist.`,
          sourceEntity: token,
        });
      }
    }
  }
  return out;
}

function componentTokens(component: Entity): string[] {
  const out = new Set<string>();
  if (Array.isArray(component.data.tokens)) {
    for (const token of component.data.tokens) {
      if (typeof token === "string") out.add(normalizeTokenId(token));
    }
  }
  if (Array.isArray(component.data.platforms)) {
    for (const platform of component.data.platforms) {
      if (!isRecord(platform) || !isRecord(platform.tokens)) continue;
      for (const token of Object.values(platform.tokens)) {
        if (typeof token === "string") out.add(normalizeTokenId(token));
      }
    }
  }
  return [...out];
}

function isThemeSensitiveToken(token: string): boolean {
  const path = token.slice("token:".length);
  return path.startsWith("color.") || path.startsWith("state.") || path.startsWith("dataviz.");
}

function validateDataViz(
  entities: ReadonlyMap<string, Entity>,
  dataViz: z.infer<typeof DataVizSchema> | undefined,
): z.infer<typeof ContractViolationSchema>[] {
  if (!dataViz) return [];
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  if (dataViz.requireSummary && !dataViz.summary?.trim()) {
    out.push({
      ruleId: "dataviz-summary-required",
      severity: "error",
      path: "dataViz.summary",
      message: "Charts must include a text summary.",
    });
  }
  for (const token of dataViz.seriesTokens) {
    const entity = entities.get(normalizeTokenId(token));
    if (!entity || entity.type !== "token" || !entity.id.startsWith("token:dataviz.")) {
      out.push({
        ruleId: "dataviz-token-required",
        severity: "error",
        path: "dataViz.seriesTokens",
        message: `${token} is not an approved data-viz token.`,
        suggestion: "Use token:dataviz.* for chart series colors.",
      });
    }
  }
  return out;
}

function validateLayout(
  entities: ReadonlyMap<string, Entity>,
  layout: z.infer<typeof LayoutSchema> | undefined,
): z.infer<typeof ContractViolationSchema>[] {
  if (!layout) return [];
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  for (const token of layout.gapTokens) {
    const entity = entities.get(normalizeTokenId(token));
    if (!entity || entity.type !== "token") {
      out.push({
        ruleId: "layout-token-missing",
        severity: "error",
        path: "layout.gapTokens",
        message: `${token} is not a known layout token.`,
      });
    }
  }
  for (const raw of layout.rawValues) {
    if (/\d+(?:px|rem|em|%)\b/.test(raw)) {
      out.push({
        ruleId: "layout-raw-value",
        severity: "error",
        path: "layout.rawValues",
        message: `Raw layout value ${raw} must be replaced with a token.`,
      });
    }
  }
  if (layout.columns !== undefined && layout.columns > layout.maxColumns) {
    out.push({
      ruleId: "layout-too-many-columns",
      severity: "error",
      path: "layout.columns",
      message: `Grid has ${layout.columns} columns; maximum is ${layout.maxColumns}.`,
    });
  }
  return out;
}

function validatePackages(
  entities: ReadonlyMap<string, Entity>,
  packages: z.infer<typeof PackageSchema>[],
): z.infer<typeof ContractViolationSchema>[] {
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  for (const pkg of packages) {
    const component = pkg.component ? entities.get(pkg.component) : undefined;
    if (pkg.component && (!component || component.type !== "component")) {
      out.push({
        ruleId: "package-component-missing",
        severity: "error",
        path: "packages.component",
        message: `${pkg.component} is not a known component.`,
      });
      continue;
    }
    const deps = component?.data.dependencies;
    if (pkg.component && !Array.isArray(deps)) {
      out.push({
        ruleId: "package-dependencies-missing",
        severity: "error",
        path: "packages.component",
        message: `${pkg.component} does not declare package dependencies.`,
      });
      continue;
    }
    if (!Array.isArray(deps)) continue;
    const dep = deps.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "package" in entry &&
        (entry as { package?: unknown }).package === pkg.package,
    ) as { version?: string } | undefined;
    if (!dep) {
      out.push({
        ruleId: "package-not-declared",
        severity: "error",
        path: "packages",
        message: `${pkg.package} is not declared for ${pkg.component}.`,
      });
      continue;
    }
    if (pkg.version && dep.version && !versionSatisfies(pkg.version, dep.version)) {
      out.push({
        ruleId: "package-version-mismatch",
        severity: "error",
        path: "packages.version",
        message: `${pkg.package}@${pkg.version} does not satisfy declared ${dep.version}.`,
      });
    }
    const peerDeps = deps.filter(
      (entry): entry is { package?: string; version?: string; type?: string } =>
        isRecord(entry) && entry.type === "peer",
    );
    for (const peer of peerDeps) {
      if (!peer.package || !peer.version) continue;
      const actualPeer = pkg.peerDependencies[peer.package];
      if (!actualPeer) {
        out.push({
          ruleId: "package-peer-missing",
          severity: "error",
          path: "packages.peerDependencies",
          message: `${pkg.component} requires peer ${peer.package}@${peer.version}.`,
        });
      } else if (!versionSatisfies(actualPeer, peer.version)) {
        out.push({
          ruleId: "package-peer-version-mismatch",
          severity: "error",
          path: "packages.peerDependencies",
          message: `${peer.package}@${actualPeer} does not satisfy declared peer ${peer.version}.`,
        });
      }
    }
  }
  return out;
}

function validatePlatformUsage(
  entities: ReadonlyMap<string, Entity>,
  usage: z.infer<typeof PlatformUsageSchema> | undefined,
): z.infer<typeof ContractViolationSchema>[] {
  if (!usage) return [];
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  for (const selected of usage.components) {
    const entity = entities.get(selected.id);
    const mapping = entity
      ? platformMappingFor(entity, usage.platform, usage.framework)
      : undefined;
    if (!mapping || !isRecord(mapping)) {
      out.push({
        ruleId: "platform-mapping-missing",
        severity: "error",
        path: `platformUsage.components.${selected.id}`,
        message: `${selected.id} has no ${usage.platform}/${usage.framework ?? "*"} mapping.`,
      });
      continue;
    }
    if (selected.package && mapping.package !== selected.package) {
      out.push({
        ruleId: "platform-package-mismatch",
        severity: "error",
        path: `platformUsage.components.${selected.id}.package`,
        message: `${selected.id} must use package ${String(mapping.package)} for ${usage.platform}.`,
      });
    }
    if (selected.importPath && mapping.importPath !== selected.importPath) {
      out.push({
        ruleId: "platform-import-mismatch",
        severity: "error",
        path: `platformUsage.components.${selected.id}.importPath`,
        message: `${selected.id} must use importPath ${String(mapping.importPath)} for ${usage.platform}.`,
      });
    }
  }
  return out;
}

function platformMappingFor(
  component: Entity,
  platform: string,
  framework: string | undefined,
): Record<string, unknown> | undefined {
  const mappings = Array.isArray(component.data.platforms) ? component.data.platforms : [];
  const platformMatches = mappings.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && normalize(entry.platform) === normalize(platform),
  );
  if (framework) {
    const exact = platformMatches.find(
      (entry) => normalize(entry.framework) === normalize(framework),
    );
    if (exact) return exact;
  }
  return platformMatches.find((entry) => !entry.framework || !framework);
}

function validateVisualRegression(
  visual: z.infer<typeof VisualRegressionSchema> | undefined,
): z.infer<typeof ContractViolationSchema>[] {
  if (!visual) return [];
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  if (
    Math.abs(visual.baseline.width - visual.current.width) > visual.maxDimensionDelta ||
    Math.abs(visual.baseline.height - visual.current.height) > visual.maxDimensionDelta
  ) {
    out.push({
      ruleId: "visual-dimensions-changed",
      severity: "error",
      path: "visualRegression.current",
      message: "Current visual dimensions exceed the allowed baseline delta.",
    });
  }
  if (
    visual.requireHashMatch &&
    visual.baseline.hash &&
    visual.current.hash !== visual.baseline.hash
  ) {
    out.push({
      ruleId: "visual-hash-changed",
      severity: "error",
      path: "visualRegression.current.hash",
      message: "Current visual hash does not match the baseline hash.",
    });
  }
  if (
    visual.diffPixels !== undefined &&
    visual.maxDiffPixels !== undefined &&
    visual.diffPixels > visual.maxDiffPixels
  ) {
    out.push({
      ruleId: "visual-diff-pixels-too-high",
      severity: "error",
      path: "visualRegression.diffPixels",
      message: `Visual diff has ${visual.diffPixels} changed pixels; maximum is ${visual.maxDiffPixels}.`,
    });
  }
  if (
    visual.diffRatio !== undefined &&
    visual.maxDiffRatio !== undefined &&
    visual.diffRatio > visual.maxDiffRatio
  ) {
    out.push({
      ruleId: "visual-diff-ratio-too-high",
      severity: "error",
      path: "visualRegression.diffRatio",
      message: `Visual diff ratio ${visual.diffRatio} exceeds maximum ${visual.maxDiffRatio}.`,
    });
  }
  return out;
}

function validateExternalImport(
  entities: ReadonlyMap<string, Entity>,
  designImport: z.infer<typeof ExternalDesignImportSchema> | undefined,
): z.infer<typeof ContractViolationSchema>[] {
  if (!designImport) return [];
  const out: z.infer<typeof ContractViolationSchema>[] = [];
  for (const token of designImport.mappedTokens) {
    const entity = entities.get(normalizeTokenId(token));
    if (!entity || entity.type !== "token") {
      out.push({
        ruleId: "external-token-mapping-missing",
        severity: "error",
        path: "externalDesignImport.mappedTokens",
        message: `${token} is not a known token mapping.`,
      });
    }
  }
  for (const component of designImport.mappedComponents) {
    const entity = entities.get(component);
    if (!entity || entity.type !== "component") {
      out.push({
        ruleId: "external-component-mapping-missing",
        severity: "error",
        path: "externalDesignImport.mappedComponents",
        message: `${component} is not a known component mapping.`,
      });
    }
  }
  if (designImport.unmappedItems.length > 0) {
    out.push({
      ruleId: "external-unmapped-items",
      severity: "error",
      path: "externalDesignImport.unmappedItems",
      message: `${designImport.source} import has unmapped items: ${designImport.unmappedItems.join(", ")}.`,
    });
  }
  return out;
}

function colorFor(entities: ReadonlyMap<string, Entity>, value: string): string | undefined {
  if (value.startsWith("#")) return isValidHexColor(value) ? value : undefined;
  const entity = entities.get(normalizeTokenId(value));
  const raw = entity?.data.value;
  return typeof raw === "string" && raw.startsWith("#") && isValidHexColor(raw) ? raw : undefined;
}

function isValidHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function normalizeTokenId(value: string): string {
  return value.startsWith("token:") ? value : `token:${value}`;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "");
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => `${c}${c}`)
          .join("")
      : cleaned.slice(0, 6);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function versionSatisfies(actual: string, expected: string): boolean {
  if (expected.startsWith("^")) return actual.split(".")[0] === expected.slice(1).split(".")[0];
  if (expected.startsWith(">=")) return compareVersions(actual, expected.slice(2)) >= 0;
  return actual === expected;
}

function compareVersions(a: string, b: string): number {
  const ap = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bp = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const delta = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}
