import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSourceAdapter } from "../../../src/source/local.js";
import { SourceManager } from "../../../src/source/manager.js";
import { handler } from "../../../src/tools/validate-ui.js";
import { ToolError } from "../../../src/util/errors.js";
import { LayeredCache } from "../../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });
let manager: SourceManager;
let cache: LayeredCache;
const ctx = () => ({ source: manager, cache, logger, requestId: "t" });

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

describe("validate_ui", () => {
  it("returns ok=true with no violations on clean code", async () => {
    const r = await handler.handle(
      {
        code: "const c = 'var(--color-action-primary)';",
        language: "tsx",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("reports a hex-color violation with line/column", async () => {
    const r = await handler.handle(
      {
        code: "const c = '#2563EB';",
        language: "tsx",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    const v = r.violations[0];
    expect(v?.ruleId).toBe("no-hex-colors");
    expect(v?.severity).toBe("error");
    expect(v?.line).toBe(1);
    expect(v?.match).toBe("#2563EB");
  });

  it("filters by `rules` argument when supplied", async () => {
    const r = await handler.handle(
      {
        code: "const c = '#2563EB'; // TODO fix",
        language: "tsx",
        rules: ["no-hex-colors"],
      },
      ctx(),
    );
    expect(r.ranRules).toEqual(["no-hex-colors"]);
  });

  it("ignores rules whose `appliesTo` does not include the language", async () => {
    // This rule applies to tsx + css. With language=html it should not fire.
    const r = await handler.handle(
      {
        code: "<p style='color: #2563EB'>hi</p>",
        language: "html",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
  });

  it("returns the bundleVersion", async () => {
    const r = await handler.handle({ code: "x", language: "tsx", rules: [] }, ctx());
    expect(typeof r.bundleVersion).toBe("string");
    expect(r.bundleVersion.length).toBeGreaterThan(0);
  });

  it("rejects unknown rule ids in `rules`", async () => {
    await expect(
      handler.handle(
        {
          code: "x",
          language: "tsx",
          rules: ["does-not-exist"],
        },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("reports multiple violations and orders them by line/column", async () => {
    const code = ["const a = '#fff';", "const b = '#000';"].join("\n");
    const r = await handler.handle({ code, language: "tsx", rules: [] }, ctx());
    expect(r.violations.length).toBeGreaterThanOrEqual(2);
    expect(r.violations[0]?.line).toBeLessThanOrEqual(r.violations[1]?.line ?? 0);
  });
});
