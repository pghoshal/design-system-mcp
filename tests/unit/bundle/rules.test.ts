import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules } from "../../../src/bundle/rules.js";

const logger = pino({ level: "silent" });

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-rules-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRule(filename: string, body: unknown): Promise<void> {
  const dir = path.join(tmpDir, "rules");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(body), "utf8");
}

describe("loadRules", () => {
  it("returns [] when rules/ directory is absent", async () => {
    const result = await loadRules(tmpDir, logger);
    expect(result).toEqual([]);
  });

  it("returns [] when rules/ is empty", async () => {
    await fs.mkdir(path.join(tmpDir, "rules"), { recursive: true });
    const result = await loadRules(tmpDir, logger);
    expect(result).toEqual([]);
  });

  it("loads a valid regex rule", async () => {
    await writeRule("no-hex.json", {
      id: "no-hex",
      description: "no raw hex",
      severity: "error",
      appliesTo: ["tsx", "css"],
      detector: { type: "regex", pattern: "#[0-9a-f]+", message: "use a token" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("no-hex");
    expect(result[0]?.detector.type).toBe("regex");
  });

  it("loads a valid JSX prop value AST rule", async () => {
    await writeRule("no-ghost-button.json", {
      id: "no-ghost-button",
      description: "no ghost buttons",
      severity: "error",
      appliesTo: ["tsx"],
      detector: {
        type: "jsx-prop-value",
        component: "Button",
        prop: "variant",
        disallow: ["ghost"],
        message: "Button variant '{value}' is not allowed",
      },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.detector.type).toBe("jsx-prop-value");
  });

  it("loads React Native JSX prop value AST rules", async () => {
    await writeRule("no-ghost-button-native.json", {
      id: "no-ghost-button-native",
      description: "no ghost buttons in native",
      severity: "error",
      appliesTo: ["react-native"],
      detector: {
        type: "jsx-prop-value",
        component: "Button",
        prop: "variant",
        disallow: ["ghost"],
        message: "Button variant '{value}' is not allowed",
      },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.appliesTo).toEqual(["react-native"]);
  });

  it("loads regex rules for React Native source", async () => {
    await writeRule("no-native-hex.json", {
      id: "no-native-hex",
      description: "no raw native colors",
      severity: "error",
      appliesTo: ["react-native"],
      detector: { type: "regex", pattern: "#[0-9a-f]+", message: "use a token" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(1);
  });

  it("loads multiple rules", async () => {
    await writeRule("a.json", {
      id: "rule-a",
      description: "a",
      severity: "warning",
      appliesTo: ["tsx"],
      detector: { type: "regex", pattern: "a", message: "no a" },
    });
    await writeRule("b.json", {
      id: "rule-b",
      description: "b",
      severity: "info",
      appliesTo: ["css"],
      detector: { type: "regex", pattern: "b", message: "no b" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["rule-a", "rule-b"]);
  });

  it("skips invalid rules and continues with the rest", async () => {
    await writeRule("good.json", {
      id: "good",
      description: "ok",
      severity: "error",
      appliesTo: ["tsx"],
      detector: { type: "regex", pattern: "x", message: "no x" },
    });
    await writeRule("bad.json", { id: "bad" }); // missing required fields
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("good");
  });

  it("rejects rules with unknown detector types", async () => {
    await writeRule("evil.json", {
      id: "evil",
      description: "x",
      severity: "error",
      appliesTo: ["tsx"],
      detector: { type: "shellcommand", message: "no" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toEqual([]);
  });

  it("rejects JSX prop value rules for non-JSX languages", async () => {
    await writeRule("bad-jsx-language.json", {
      id: "bad-jsx-language",
      description: "bad",
      severity: "error",
      appliesTo: ["css"],
      detector: {
        type: "jsx-prop-value",
        component: "Button",
        prop: "variant",
        disallow: ["ghost"],
        message: "no ghost",
      },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toEqual([]);
  });

  it("rejects regex rules with invalid patterns", async () => {
    await writeRule("bad-pattern.json", {
      id: "bad-pattern",
      description: "x",
      severity: "error",
      appliesTo: ["tsx"],
      detector: { type: "regex", pattern: "[", message: "no" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toEqual([]);
  });

  it("rejects regex rules with invalid flags", async () => {
    await writeRule("bad-flags.json", {
      id: "bad-flags",
      description: "x",
      severity: "error",
      appliesTo: ["tsx"],
      detector: { type: "regex", pattern: "x", flags: "bad", message: "no" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toEqual([]);
  });

  it("rejects duplicate rule ids (first wins)", async () => {
    await writeRule("dup1.json", {
      id: "dup",
      description: "first",
      severity: "warning",
      appliesTo: ["tsx"],
      detector: { type: "regex", pattern: "x", message: "1" },
    });
    await writeRule("dup2.json", {
      id: "dup",
      description: "second",
      severity: "error",
      appliesTo: ["tsx"],
      detector: { type: "regex", pattern: "y", message: "2" },
    });
    const result = await loadRules(tmpDir, logger);
    expect(result).toHaveLength(1);
  });
});
