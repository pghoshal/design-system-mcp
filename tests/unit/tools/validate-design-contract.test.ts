import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../../src/source/local.js";
import { SourceManager } from "../../../src/source/manager.js";
import {
  expectedWorkflowResultHashesForInput,
  handler,
} from "../../../src/tools/validate-design-contract.js";
import { LayeredCache } from "../../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });
let manager: SourceManager;
let cache: LayeredCache;
const ctx = () => ({ source: manager, cache, logger, requestId: "validate-contract-test" });

const allWorkflowTools = [
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
] as const;

async function requiredEvidence() {
  const bundleVersion = manager.current().version;
  const evidence = {
    workflowEvidence: {
      requiredToolsUsed: [...allWorkflowTools],
      toolResults: [],
      resourcesRead: ["design://workflow"],
      coverageProfile: "enterprise" as const,
      coverageInspected: true,
    },
    componentSourceEvidence: {
      mode: "imported" as const,
      targetPlatform: "react-native",
      targetFramework: "react-native",
      components: [
        {
          id: "component:button",
          sourceChecked: true,
          usageChecked: true,
          sourceFiles: ["components/Button/component.json"],
          imported: true,
          package: "@acme/react-native-ui",
          importPath: "@acme/react-native-ui/button",
        },
      ],
    },
    tokenResolutionEvidence: {
      resolvedTokens: [{ id: "token:color.action.primary" }, { id: "token:space.4" }],
      cssVariables: ["--color-action-primary", "--space-4"],
    },
    decisionEvidence: {
      explainedEntities: ["component:button", "token:color.action.primary"],
    },
  };
  const expectedHashes = await expectedWorkflowResultHashesForInput(manager.current(), evidence);
  return {
    ...evidence,
    workflowEvidence: {
      ...evidence.workflowEvidence,
      toolResults: allWorkflowTools.map((tool) => ({
        tool,
        ok: true,
        bundleVersion,
        resultHash: expectedHashes.get(tool) ?? `sha256:${tool}-not-verifiable-in-unit-test`,
      })),
    },
  };
}

beforeAll(async () => {
  cache = new LayeredCache();
  manager = new SourceManager({
    adapter: new LocalSourceAdapter(FIXTURE, logger),
    logger,
    refreshIntervalSec: 60,
  });
  await manager.initial();
}, 30_000);

afterAll(async () => {
  await manager.stop();
});

describe("validate_design_contract", () => {
  it("accepts valid structured handoff evidence", async () => {
    const result = await handler.handle(
      {
        ...(await requiredEvidence()),
        contrastPairs: [
          {
            foreground: "token:color.text.primary",
            background: "token:color.surface.default",
            minimumRatio: 4.5,
          },
        ],
        dataViz: {
          seriesTokens: ["token:dataviz.risk.high"],
          summary: "High risk invoices increased this week.",
        },
        layout: { gapTokens: ["token:space.4"], columns: 8, maxColumns: 12 },
        packages: [
          {
            component: "component:button",
            package: "@acme/ui",
            version: "2.2.0",
            peerDependencies: { react: "18.2.0" },
          },
        ],
        platformUsage: {
          platform: "react-native",
          framework: "react-native",
          components: [
            {
              id: "component:button",
              package: "@acme/react-native-ui",
              importPath: "@acme/react-native-ui/button",
            },
          ],
        },
        visualRegression: {
          baseline: { width: 1440, height: 900, hash: "abc" },
          current: { width: 1440, height: 900, hash: "abc" },
          requireHashMatch: true,
          diffPixels: 0,
          maxDiffPixels: 25,
          diffRatio: 0,
          maxDiffRatio: 0.001,
        },
        externalDesignImport: {
          source: "figma",
          mappedTokens: ["token:color.action.primary"],
          mappedComponents: ["component:button"],
          unmappedItems: [],
        },
      },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("reports contrast, data-viz, layout, package, platform, visual, and import gaps", async () => {
    const result = await handler.handle(
      {
        ...(await requiredEvidence()),
        contrastPairs: [{ foreground: "#ffffff", background: "#ffffff", minimumRatio: 4.5 }],
        dataViz: { seriesTokens: ["token:color.action.primary"], requireSummary: true },
        layout: { rawValues: ["24px"], columns: 16, maxColumns: 12 },
        packages: [{ component: "component:button", package: "@acme/ui", version: "1.0.0" }],
        platformUsage: {
          platform: "react-native",
          framework: "react-native",
          components: [{ id: "component:button", package: "@wrong/ui" }],
        },
        visualRegression: {
          baseline: { width: 1440, height: 900, hash: "abc" },
          current: { width: 1200, height: 900, hash: "def" },
          requireHashMatch: true,
          diffPixels: 200,
          maxDiffPixels: 20,
          diffRatio: 0.02,
          maxDiffRatio: 0.001,
        },
        externalDesignImport: {
          source: "figma",
          mappedTokens: ["token:not.real"],
          mappedComponents: ["component:not-real"],
          unmappedItems: ["frame:hero"],
        },
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual(
      expect.arrayContaining([
        "contrast-ratio-too-low",
        "dataviz-summary-required",
        "dataviz-token-required",
        "layout-raw-value",
        "layout-too-many-columns",
        "package-version-mismatch",
        "package-peer-missing",
        "platform-package-mismatch",
        "visual-dimensions-changed",
        "visual-hash-changed",
        "visual-diff-pixels-too-high",
        "visual-diff-ratio-too-high",
        "external-token-mapping-missing",
        "external-component-mapping-missing",
        "external-unmapped-items",
      ]),
    );
  });

  it("rejects malformed raw hex colors and unknown package components", async () => {
    const result = await handler.handle(
      {
        ...(await requiredEvidence()),
        contrastPairs: [{ foreground: "#nothex", background: "#ffffff", minimumRatio: 4.5 }],
        packages: [{ component: "component:not-real", package: "@acme/ui", version: "1.0.0" }],
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual(
      expect.arrayContaining(["contrast-token-unresolved", "package-component-missing"]),
    );
  });

  it("fails themed handoff evidence when component tokens lack theme variants", async () => {
    const result = await handler.handle(
      {
        ...(await requiredEvidence()),
        themeCoverage: {
          themes: ["dark", "highContrast"],
          components: ["component:button"],
          tokens: ["token:color.action.primary"],
        },
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toContain(
      "theme-token-variant-missing",
    );
    expect(result.violations[0]?.message).toContain("token:theme.dark.color.action.primary");
  });

  it("fails final handoff when required workflow tools and component source evidence are missing", async () => {
    const result = await handler.handle(
      {
        ...(await requiredEvidence()),
        workflowEvidence: {
          requiredToolsUsed: ["describe_schema", "validate_ui"],
          resourcesRead: [],
          coverageProfile: "community",
          coverageInspected: false,
        },
        componentSourceEvidence: {
          mode: "html-adapter",
          targetPlatform: "web",
          targetFramework: "react",
          components: [
            {
              id: "component:button",
              sourceChecked: false,
              usageChecked: false,
              sourceFiles: [],
              canonicalStructureMirrored: false,
            },
          ],
        },
        tokenResolutionEvidence: {
          resolvedTokens: [],
          cssVariables: ["not-a-var"],
        },
        decisionEvidence: {
          explainedEntities: [],
        },
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual(
      expect.arrayContaining([
        "workflow-required-tool-missing",
        "workflow-coverage-not-inspected",
        "workflow-enterprise-coverage-required",
        "component-source-not-consulted",
        "component-usage-not-consulted",
        "component-decision-not-explained",
        "component-adapter-not-allowed",
        "component-adapter-structure-unverified",
        "component-adapter-rationale-required",
        "token-resolution-evidence-empty",
        "token-resolution-css-var-invalid",
        "decision-evidence-empty",
      ]),
    );
  });

  it("rejects fabricated workflow hashes for bundle-bound evidence", async () => {
    const evidence = await requiredEvidence();
    const result = await handler.handle(
      {
        ...evidence,
        workflowEvidence: {
          ...evidence.workflowEvidence,
          toolResults: evidence.workflowEvidence.toolResults.map((entry) =>
            entry.tool === "get_component_source"
              ? { ...entry, resultHash: "sha256:fabricated" }
              : entry,
          ),
        },
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toContain(
      "workflow-tool-result-hash-mismatch",
    );
  });

  it("allows html adapter mode only when no platform implementation mapping exists", async () => {
    const evidence = await requiredEvidence();
    const htmlEvidence = {
      ...evidence,
      componentSourceEvidence: {
        mode: "html-adapter" as const,
        targetPlatform: "html",
        targetFramework: "static",
        components: [
          {
            id: "component:button",
            sourceChecked: true,
            usageChecked: true,
            sourceFiles: ["components/Button/component.json"],
            adapterRationale:
              "The requested artifact is static HTML; no HTML component mapping exists.",
            canonicalStructureMirrored: true,
          },
        ],
      },
    };
    const expectedHashes = await expectedWorkflowResultHashesForInput(
      manager.current(),
      htmlEvidence,
    );
    const result = await handler.handle(
      {
        ...htmlEvidence,
        workflowEvidence: {
          ...htmlEvidence.workflowEvidence,
          toolResults: htmlEvidence.workflowEvidence.toolResults.map((entry) => ({
            ...entry,
            resultHash: expectedHashes.get(entry.tool) ?? entry.resultHash,
          })),
        },
      },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("requires package and importPath evidence in imported mode", async () => {
    const result = await handler.handle(
      {
        ...(await requiredEvidence()),
        componentSourceEvidence: {
          mode: "imported",
          targetPlatform: "web",
          targetFramework: "react",
          components: [
            {
              id: "component:button",
              sourceChecked: true,
              usageChecked: true,
              sourceFiles: ["components/Button/component.json"],
              imported: true,
            },
          ],
        },
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual(
      expect.arrayContaining([
        "component-source-package-required",
        "component-source-import-required",
      ]),
    );
  });
});
