import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTokens } from "../../../src/bundle/tokens.js";

const logger = pino({ level: "silent" });

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-md-tokens-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("markdown token sources", () => {
  it("loads tokens from root design markdown when no tokens directory exists", async () => {
    await fs.writeFile(
      path.join(tmpDir, "design.md"),
      `---
tokens:
  color:
    brand:
      primary:
        value: "#2563EB"
        type: color
        description: Markdown primary color.
      primaryHover:
        value: "{color.brand.primary}"
        type: color
---

# Markdown-only design system
`,
      "utf8",
    );

    const result = await loadTokens(tmpDir, logger);
    const primary = result.entities.find((entity) => entity.id === "token:color.brand.primary");
    const hover = result.entities.find((entity) => entity.id === "token:color.brand.primaryHover");

    expect(primary?.data.value).toBe("#2563EB");
    expect(primary?.data.$type).toBe("color");
    expect(primary?.source.path).toBe("design.md");
    expect(hover?.data.value).toBe("#2563EB");
    expect(hover?.source.path).toBe("design.md");
  });

  it("applies markdown token sources after sorted json sources in hybrid repos", async () => {
    await fs.mkdir(path.join(tmpDir, "tokens"));
    await fs.writeFile(
      path.join(tmpDir, "tokens", "z.tokens.json"),
      JSON.stringify({
        color: {
          brand: {
            primary: {
              $value: "#111111",
              $type: "color",
            },
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "tokens", "a.tokens.json"),
      JSON.stringify({
        spacing: {
          sm: {
            $value: "4px",
            $type: "dimension",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "design.md"),
      `---
tokens:
  color:
    brand:
      primary:
        value: "#222222"
        type: color
---

# Hybrid design system
`,
      "utf8",
    );

    const result = await loadTokens(tmpDir, logger);
    const primary = result.entities.find((entity) => entity.id === "token:color.brand.primary");
    const spacing = result.entities.find((entity) => entity.id === "token:spacing.sm");

    expect(primary?.data.value).toBe("#222222");
    expect(primary?.source.path).toBe("design.md");
    expect(spacing?.data.value).toBe("4px");
    expect(spacing?.source.path).toBe("tokens/a.tokens.json");
  });
});
