import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTokens } from "../../../src/bundle/tokens.js";

const logger = pino({ level: "silent" });

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-tokens-studio-test-"));
  await fs.mkdir(path.join(tmpDir, "tokens"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Tokens Studio token sources", () => {
  it("resolves unqualified references against the global token set", async () => {
    await fs.writeFile(
      path.join(tmpDir, "tokens", "tokens.tokens.json"),
      JSON.stringify({
        global: {
          color: {
            primary: {
              40: { value: "#6750a4", type: "color" },
              100: { value: "#ffffff", type: "color" },
            },
          },
          fontFamilies: {
            roboto: { value: "Roboto", type: "fontFamilies" },
          },
        },
        "material-3-color": {
          theme: {
            light: {
              primary: { value: "{color.primary.40}", type: "color" },
              "on-primary": { value: "{color.primary.100}", type: "color" },
            },
          },
        },
        "material-3-text": {
          title: {
            large: {
              value: {
                fontFamily: "{fontFamilies.roboto}",
              },
              type: "typography",
            },
          },
        },
        $metadata: {
          tokenSetOrder: ["global"],
        },
      }),
      "utf8",
    );

    const result = await loadTokens(tmpDir, logger);
    const primary = result.entities.find(
      (entity) => entity.id === "token:material-3-color.theme.light.primary",
    );
    const title = result.entities.find(
      (entity) => entity.id === "token:material-3-text.title.large",
    );

    expect(primary?.data.value).toBe("#6750a4");
    expect(primary?.source.path).toBe("tokens/tokens.tokens.json");
    expect(title?.data.value).toEqual(expect.objectContaining({ fontFamily: "Roboto" }));
  });

  it("resolves unqualified references across split token set files", async () => {
    await fs.writeFile(
      path.join(tmpDir, "tokens", "global.tokens.json"),
      JSON.stringify({
        global: {
          color: {
            primary: {
              40: { value: "#6750a4", type: "color" },
            },
          },
        },
        $metadata: {
          tokenSetOrder: ["global"],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "tokens", "semantic.tokens.json"),
      JSON.stringify({
        "material-3-color": {
          theme: {
            light: {
              primary: { value: "{color.primary.40}", type: "color" },
            },
          },
        },
        $metadata: {
          tokenSetOrder: ["global"],
        },
      }),
      "utf8",
    );

    const result = await loadTokens(tmpDir, logger);
    const primary = result.entities.find(
      (entity) => entity.id === "token:material-3-color.theme.light.primary",
    );

    expect(primary?.data.value).toBe("#6750a4");
    expect(primary?.data.original).toBe("{global.color.primary.40}");
    expect(primary?.source.path).toBe("tokens/semantic.tokens.json");
  });

  it("leaves ambiguous unqualified references unresolved so Style Dictionary fails", async () => {
    await fs.writeFile(
      path.join(tmpDir, "tokens", "tokens.tokens.json"),
      JSON.stringify({
        global: {
          color: {
            primary: {
              40: { value: "#6750a4", type: "color" },
            },
          },
        },
        brand: {
          color: {
            primary: {
              40: { value: "#0057ff", type: "color" },
            },
          },
        },
        "material-3-color": {
          theme: {
            light: {
              primary: { value: "{color.primary.40}", type: "color" },
            },
          },
        },
        $metadata: {
          tokenSetOrder: ["global", "brand"],
        },
      }),
      "utf8",
    );

    await expect(loadTokens(tmpDir, logger)).rejects.toThrow("Reference Errors");
  });
});
