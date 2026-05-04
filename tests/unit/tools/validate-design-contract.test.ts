import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../../src/source/local.js";
import { SourceManager } from "../../../src/source/manager.js";
import { handler } from "../../../src/tools/validate-design-contract.js";
import { LayeredCache } from "../../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });
let manager: SourceManager;
let cache: LayeredCache;
const ctx = () => ({ source: manager, cache, logger, requestId: "validate-contract-test" });

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
});
