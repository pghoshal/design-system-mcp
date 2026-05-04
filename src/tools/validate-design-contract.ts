import { z } from "zod";
import type { Entity } from "../bundle/types.js";
import type { ToolHandler } from "../server/types.js";

const SeveritySchema = z.enum(["error", "warning", "info"]);

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

export const ValidateDesignContractInput = z.object({
  theme: z.enum(["light", "dark", "highContrast"]).optional(),
  contrastPairs: z.array(ContrastPairSchema).default([]),
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
    const violations: z.infer<typeof ContractViolationSchema>[] = [
      ...validateContrast(bundle.entities, input.contrastPairs),
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
    const mappings = Array.isArray(entity?.data.platforms) ? entity.data.platforms : [];
    const mapping = mappings.find(
      (entry) =>
        isRecord(entry) &&
        normalize(entry.platform) === normalize(usage.platform) &&
        (!usage.framework ||
          !entry.framework ||
          normalize(entry.framework) === normalize(usage.framework)),
    );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}
