import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "design-systems", "sample");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(REPO_ROOT, "src", "validate-cli.ts");
const PNPM_CLI = process.env.npm_execpath;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-validate-cli-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("validate CLI", () => {
  it("exits 0 and prints JSON for clean files", async () => {
    const file = path.join(tmpDir, "clean.tsx");
    await fs.writeFile(file, "const color = 'var(--color-action-primary)';\n", "utf8");

    const { stdout } = await execFileAsync(TSX_BIN, [
      ENTRY,
      "--source",
      FIXTURE,
      "--format",
      "json",
      file,
    ]);

    const parsed = JSON.parse(stdout) as { ok: boolean; counts: { error: number } };
    expect(parsed.ok).toBe(true);
    expect(parsed.counts.error).toBe(0);
  }, 30_000);

  it("supports the documented pnpm validate -- --source invocation", async () => {
    if (!PNPM_CLI) throw new Error("npm_execpath missing; run tests through pnpm");
    const file = path.join(tmpDir, "clean.tsx");
    await fs.writeFile(file, "const color = 'var(--color-action-primary)';\n", "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [PNPM_CLI, "validate", "--", "--source", FIXTURE, "--format", "json", file],
      { cwd: REPO_ROOT },
    );

    const jsonStart = stdout.indexOf("{");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(jsonStart)) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  }, 30_000);

  it("exits 1 and includes violation provenance for error files", async () => {
    const file = path.join(tmpDir, "bad.tsx");
    await fs.writeFile(file, "const color = '#2563EB';\n", "utf8");

    await expect(
      execFileAsync(TSX_BIN, [ENTRY, "--source", FIXTURE, "--format", "json", file]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"rulePath": "rules/no-hex-colors.json"'),
    });
  });

  it("prints deterministic repair payloads when a violation is auto-fixable", async () => {
    const file = path.join(tmpDir, "deprecated-token.css");
    await fs.writeFile(
      file,
      ".x { color: var(--color-action-legacyPrimary, var(--color-action-primary)); }\n",
      "utf8",
    );

    await expect(
      execFileAsync(TSX_BIN, [
        ENTRY,
        "--source",
        FIXTURE,
        "--format",
        "json",
        "--rules",
        "no-deprecated-tokens",
        file,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(
        '"after": "var(--color-action-primary, var(--color-action-primary))"',
      ),
    });
  });

  it("prints SARIF for code-scanning integrations", async () => {
    const file = path.join(tmpDir, "bad.tsx");
    await fs.writeFile(file, "const color = '#2563EB';\n", "utf8");

    await expect(
      execFileAsync(TSX_BIN, [ENTRY, "--source", FIXTURE, "--format", "sarif", file]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"version": "2.1.0"'),
    });
  });

  it("includes repair payloads in SARIF properties when available", async () => {
    const file = path.join(tmpDir, "deprecated-token.css");
    await fs.writeFile(file, ".x { color: var(--color-action-legacyPrimary); }\n", "utf8");

    await expect(
      execFileAsync(TSX_BIN, [
        ENTRY,
        "--source",
        FIXTURE,
        "--format",
        "sarif",
        "--rules",
        "no-deprecated-tokens",
        file,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"repair": {'),
    });
  });

  it("validates composition plan files in CI", async () => {
    const plan = path.join(tmpDir, "composition.json");
    await fs.writeFile(
      plan,
      JSON.stringify({
        pattern: "pattern:confirmation-dialog",
        components: [{ id: "component:button", props: { variant: "danger" } }],
        tokens: [],
      }),
      "utf8",
    );

    await expect(
      execFileAsync(TSX_BIN, [ENTRY, "--source", FIXTURE, "--composition", plan]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"path": "props.children"'),
    });
  });

  it("final_check mode blocks output without composition evidence", async () => {
    const file = path.join(tmpDir, "clean.tsx");
    await fs.writeFile(file, "const color = 'var(--color-action-primary)';\n", "utf8");

    await expect(
      execFileAsync(TSX_BIN, [
        ENTRY,
        "--source",
        FIXTURE,
        "--mode",
        "final_check",
        "--format",
        "json",
        file,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"missingEvidence": ['),
    });
  });

  it("final_check mode reports missing composition evidence in SARIF", async () => {
    const file = path.join(tmpDir, "clean.tsx");
    await fs.writeFile(file, "const color = 'var(--color-action-primary)';\n", "utf8");

    await expect(
      execFileAsync(TSX_BIN, [
        ENTRY,
        "--source",
        FIXTURE,
        "--mode",
        "final_check",
        "--format",
        "sarif",
        file,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"ruleId": "harness/missing-evidence"'),
    });
  });

  it("final_check mode reports missing UI evidence in SARIF", async () => {
    const plan = path.join(tmpDir, "composition.json");
    await fs.writeFile(
      plan,
      JSON.stringify({
        pattern: "pattern:confirmation-dialog",
        platform: "web",
        framework: "react",
        components: [
          { id: "component:card", props: { title: "Delete project?", tone: "danger" } },
          {
            id: "component:button",
            parent: "component:card",
            props: { variant: "danger", children: "Delete project" },
          },
        ],
        tokens: ["token:color.action.danger", "token:color.surface.default"],
      }),
      "utf8",
    );

    await expect(
      execFileAsync(TSX_BIN, [
        ENTRY,
        "--source",
        FIXTURE,
        "--mode",
        "final_check",
        "--format",
        "sarif",
        "--composition",
        plan,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"missingEvidence": ['),
    });
  });

  it("validates design contract evidence in CI", async () => {
    const contract = path.join(tmpDir, "handoff.json");
    await fs.writeFile(
      contract,
      JSON.stringify({
        contrastPairs: [{ foreground: "#fff", background: "#fff", minimumRatio: 4.5 }],
      }),
      "utf8",
    );

    await expect(
      execFileAsync(TSX_BIN, [ENTRY, "--source", FIXTURE, "--contract", contract]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"ruleId": "contrast-ratio-too-low"'),
    });
  });

  it("final_check mode passes with clean code, composition evidence, and contract evidence", async () => {
    const file = path.join(tmpDir, "clean.tsx");
    const plan = path.join(tmpDir, "composition.json");
    const contract = path.join(tmpDir, "handoff.json");
    await fs.writeFile(file, "const color = 'var(--color-action-primary)';\n", "utf8");
    await fs.writeFile(
      plan,
      JSON.stringify({
        pattern: "pattern:confirmation-dialog",
        platform: "web",
        framework: "react",
        components: [
          { id: "component:card", props: { title: "Delete project?", tone: "danger" } },
          {
            id: "component:button",
            parent: "component:card",
            props: { variant: "danger", children: "Delete project" },
          },
        ],
        tokens: ["token:color.action.danger", "token:color.surface.default"],
      }),
      "utf8",
    );
    await fs.writeFile(
      contract,
      JSON.stringify({
        contrastPairs: [
          {
            foreground: "token:color.text.primary",
            background: "token:color.surface.default",
            minimumRatio: 4.5,
          },
        ],
        packages: [
          {
            component: "component:button",
            package: "@acme/ui",
            version: "2.2.0",
            peerDependencies: { react: "18.2.0" },
          },
        ],
        externalDesignImport: {
          source: "figma",
          mappedTokens: ["token:color.action.primary"],
          mappedComponents: ["component:button"],
          unmappedItems: [],
        },
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(TSX_BIN, [
      ENTRY,
      "--source",
      FIXTURE,
      "--mode",
      "final_check",
      "--format",
      "json",
      "--composition",
      plan,
      "--contract",
      contract,
      file,
    ]);

    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      harness: { mode: string; missingEvidence: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.harness).toEqual({
      mode: "final_check",
      missingEvidence: [],
    });
  });
});
