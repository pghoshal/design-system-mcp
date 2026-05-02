import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTokens } from "../../../src/bundle/tokens.js";

const logger = pino({ level: "silent" });

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-dtcg-alias-test-"));
  await fs.mkdir(path.join(tmpDir, "tokens"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("DTCG composite aliases", () => {
  it("resolves whole-token alias references that use the trailing @ marker", async () => {
    await fs.writeFile(
      path.join(tmpDir, "tokens", "tokens.tokens.json"),
      JSON.stringify({
        border: {
          base: { $value: "1px", $type: "dimension" },
        },
        color: {
          neutral: { $value: "#808080", $type: "color" },
        },
        composite: {
          border: {
            thin: {
              $type: "border",
              $value: {
                color: "{color.neutral}",
                width: "{border.base}",
                style: "solid",
              },
            },
            alias: {
              $type: "border",
              $value: "{composite.border.thin.@}",
            },
          },
        },
      }),
      "utf8",
    );

    const result = await loadTokens(tmpDir, logger);
    const alias = result.entities.find((entity) => entity.id === "token:composite.border.alias");

    expect(alias?.data.value).toEqual({
      color: "#808080",
      width: "1px",
      style: "solid",
    });
    expect(alias?.data.original).toBe("{composite.border.thin}");
    expect(alias?.source.path).toBe("tokens/tokens.tokens.json");
  });

  it("leaves missing trailing @ alias targets unresolved so Style Dictionary fails", async () => {
    await fs.writeFile(
      path.join(tmpDir, "tokens", "tokens.tokens.json"),
      JSON.stringify({
        composite: {
          border: {
            alias: {
              $type: "border",
              $value: "{composite.border.missing.@}",
            },
          },
        },
      }),
      "utf8",
    );

    await expect(loadTokens(tmpDir, logger)).rejects.toThrow("Reference Errors");
  });
});
