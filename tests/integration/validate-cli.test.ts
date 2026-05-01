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
  });

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
  });

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
});
