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

  it("reports raw spacing values", async () => {
    const r = await handler.handle(
      {
        code: "const style = { padding: '16px' };",
        language: "tsx",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.ruleId === "no-raw-length-values")).toBe(true);
  });

  it("reports raw color functions", async () => {
    const r = await handler.handle(
      {
        code: "const style = { color: 'rgb(37, 99, 235)' };",
        language: "tsx",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.ruleId === "no-raw-color-functions")).toBe(true);
  });

  it("reports unknown CSS token variables", async () => {
    const r = await handler.handle(
      {
        code: ".x { color: var(--color-action-missing); }",
        language: "css",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.ruleId === "no-unknown-css-vars")).toBe(true);
  });

  it("reports unknown CSS token variables with fallback arguments", async () => {
    const r = await handler.handle(
      {
        code: ".x { color: var(--color-action-missing, var(--color-action-primary)); }",
        language: "css",
        rules: ["no-unknown-css-vars"],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.ruleId).toBe("no-unknown-css-vars");
    expect(r.violations[0]?.match).toBe("var(--color-action-missing, var(--color-action-primary))");
  });

  it("ignores non-token CSS custom properties", async () => {
    const r = await handler.handle(
      {
        code: [
          ".x {",
          "  transform-origin: var(--radix-popover-content-transform-origin);",
          "  --local: var(--color-picker-thumb);",
          "  font-family: var(--font-loading-state);",
          "}",
        ].join("\n"),
        language: "css",
        rules: ["no-unknown-css-vars"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("warns when app code uses primitive CSS token variables", async () => {
    const r = await handler.handle(
      {
        code: ".x { color: var(--color-blue-500); }",
        language: "css",
        rules: [],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.ruleId === "prefer-semantic-tokens")).toBe(true);
  });

  it("can run a selected built-in semantic token rule", async () => {
    const r = await handler.handle(
      {
        code: ".x { color: var(--color-action-missing); padding: 16px; }",
        language: "css",
        rules: ["no-unknown-css-vars"],
      },
      ctx(),
    );
    expect(r.ranRules).toEqual(["no-unknown-css-vars"]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.ruleId).toBe("no-unknown-css-vars");
  });

  it("reports images without accessible text", async () => {
    const r = await handler.handle(
      {
        code: ["<img", "  src='/hero.png'", "/>"].join("\n"),
        language: "tsx",
        rules: ["a11y-img-alt"],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.ruleId).toBe("a11y-img-alt");
  });

  it("accepts decorative images with empty alt text", async () => {
    const r = await handler.handle(
      {
        code: "<img src='/divider.png' alt='' />",
        language: "tsx",
        rules: ["a11y-img-alt"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("accepts named interactive elements", async () => {
    const r = await handler.handle(
      {
        code: [
          "<img src='/hero.png' alt='Dashboard overview' />",
          "<button><span>Save</span></button>",
          "<a href='/settings'><span>Settings</span></a>",
          "<input aria-label='Email address' />",
        ].join("\n"),
        language: "tsx",
        rules: ["a11y-img-alt", "a11y-button-name", "a11y-link-name", "a11y-form-control-label"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("reports unnamed buttons and links", async () => {
    const r = await handler.handle(
      {
        code: ["<button><Icon /></button>", "<a href='/next'><ChevronRight /></a>"].join("\n"),
        language: "tsx",
        rules: ["a11y-button-name", "a11y-link-name"],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.ruleId)).toEqual(["a11y-button-name", "a11y-link-name"]);
  });

  it("reports unlabeled form controls", async () => {
    const r = await handler.handle(
      {
        code: "<input id='email' type='email' />",
        language: "tsx",
        rules: ["a11y-form-control-label"],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.ruleId).toBe("a11y-form-control-label");
  });

  it("accepts form controls associated with labels", async () => {
    const r = await handler.handle(
      {
        code: ["<label htmlFor='email'>Email</label>", "<input id='email' type='email' />"].join(
          "\n",
        ),
        language: "tsx",
        rules: ["a11y-form-control-label"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("reports positive tabindex and autofocus", async () => {
    const r = await handler.handle(
      {
        code: "<input aria-label='Search' tabIndex={2} autoFocus />",
        language: "tsx",
        rules: ["a11y-no-positive-tabindex", "a11y-no-autofocus"],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.ruleId)).toEqual([
      "a11y-no-positive-tabindex",
      "a11y-no-autofocus",
    ]);
  });

  it("reports blame language in UI copy", async () => {
    const r = await handler.handle(
      {
        code: "<p>You forgot to add a project name.</p>",
        language: "tsx",
        rules: ["copy-no-blame"],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.ruleId).toBe("copy-no-blame");
  });

  it("reports hype and exclamation marks in UI copy", async () => {
    const r = await handler.handle(
      {
        code: "<p>Awesome! Saved!</p>",
        language: "tsx",
        rules: ["copy-no-hype"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations[0]?.ruleId).toBe("copy-no-hype");
  });

  it("reports vague action labels", async () => {
    const r = await handler.handle(
      {
        code: "<button>Submit</button>",
        language: "tsx",
        rules: ["copy-no-vague-actions"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations[0]?.ruleId).toBe("copy-no-vague-actions");
  });

  it("reports vague action labels in JSX string-expression attributes", async () => {
    const r = await handler.handle(
      {
        code: '<IconButton aria-label={"Submit"} />',
        language: "tsx",
        rules: ["copy-no-vague-actions"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations[0]?.ruleId).toBe("copy-no-vague-actions");
  });

  it("reports vague action labels in component label props", async () => {
    const r = await handler.handle(
      {
        code: '<Button label="Submit" />',
        language: "tsx",
        rules: ["copy-no-vague-actions"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations[0]?.ruleId).toBe("copy-no-vague-actions");
  });

  it("reports hedging in destructive copy", async () => {
    const r = await handler.handle(
      {
        code: "<p>This might delete the project.</p>",
        language: "tsx",
        rules: ["copy-no-destructive-hedging"],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.violations[0]?.ruleId).toBe("copy-no-destructive-hedging");
  });

  it("accepts direct calm copy", async () => {
    const r = await handler.handle(
      {
        code: "<button>Delete project</button><p>This cannot be undone.</p>",
        language: "tsx",
        rules: [
          "copy-no-blame",
          "copy-no-hype",
          "copy-no-vague-actions",
          "copy-no-destructive-hedging",
        ],
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
