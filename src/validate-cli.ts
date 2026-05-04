import { promises as fs } from "node:fs";
import path from "node:path";
import pino from "pino";
import { z } from "zod";
import { RuleLanguageSchema } from "./bundle/schema.js";
import type { RuleLanguage } from "./bundle/types.js";
import { LocalSourceAdapter } from "./source/local.js";
import { SourceManager } from "./source/manager.js";
import {
  ValidateCompositionInput,
  handler as validateCompositionHandler,
} from "./tools/validate-composition.js";
import {
  ValidateDesignContractInput,
  handler as validateDesignContractHandler,
} from "./tools/validate-design-contract.js";
import { handler as validateUiHandler } from "./tools/validate-ui.js";
import { LayeredCache } from "./util/lru.js";

const HarnessModeSchema = z.enum(["plan_only", "generate", "validate", "repair", "final_check"]);
type HarnessMode = z.infer<typeof HarnessModeSchema>;

interface CliOptions {
  sourcePath: string;
  files: string[];
  compositions: string[];
  contracts: string[];
  language?: RuleLanguage | undefined;
  rules: string[];
  format: "json" | "sarif";
  mode?: HarnessMode | undefined;
}

interface FileResult {
  path: string;
  ok: boolean;
  violations: Awaited<ReturnType<typeof validateUiHandler.handle>>["violations"];
  ranRules: string[];
  bundleVersion: string;
}

interface CompositionResult {
  path: string;
  ok: boolean;
  violations: Awaited<ReturnType<typeof validateCompositionHandler.handle>>["violations"];
  checkedComponents: string[];
  bundleVersion: string;
}

interface ContractResult {
  path: string;
  ok: boolean;
  violations: Awaited<ReturnType<typeof validateDesignContractHandler.handle>>["violations"];
  bundleVersion: string;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${usage()}\n`);
    return 2;
  }

  const logger = pino({ level: "silent" });
  const source = new SourceManager({
    adapter: new LocalSourceAdapter(parsed.sourcePath, logger),
    logger,
    refreshIntervalSec: 60,
  });
  const cache = new LayeredCache();

  try {
    await source.initial();
    const results: FileResult[] = [];
    const compositions: CompositionResult[] = [];
    const contracts: ContractResult[] = [];

    for (const file of parsed.files) {
      const abs = path.resolve(file);
      const code = await fs.readFile(abs, "utf8");
      const language = parsed.language ?? inferLanguage(abs);
      const result = await validateUiHandler.handle(
        {
          code,
          language,
          rules: parsed.rules,
        },
        {
          source,
          cache,
          logger,
          requestId: "validate-cli",
        },
      );
      results.push({
        path: path.relative(process.cwd(), abs),
        ok: result.ok,
        violations: result.violations,
        ranRules: result.ranRules,
        bundleVersion: result.bundleVersion,
      });
    }

    for (const file of parsed.compositions) {
      const abs = path.resolve(file);
      const raw = JSON.parse(await fs.readFile(abs, "utf8")) as unknown;
      const input = ValidateCompositionInput.parse(raw);
      const result = await validateCompositionHandler.handle(input, {
        source,
        cache,
        logger,
        requestId: "validate-cli",
      });
      compositions.push({
        path: path.relative(process.cwd(), abs),
        ok: result.ok,
        violations: result.violations,
        checkedComponents: result.checkedComponents,
        bundleVersion: result.bundleVersion,
      });
    }

    for (const file of parsed.contracts) {
      const abs = path.resolve(file);
      const raw = JSON.parse(await fs.readFile(abs, "utf8")) as unknown;
      const input = ValidateDesignContractInput.parse(raw);
      const result = await validateDesignContractHandler.handle(input, {
        source,
        cache,
        logger,
        requestId: "validate-cli",
      });
      contracts.push({
        path: path.relative(process.cwd(), abs),
        ok: result.ok,
        violations: result.violations,
        bundleVersion: result.bundleVersion,
      });
    }

    const errorCount =
      results.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "error").length,
        0,
      ) +
      compositions.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "error").length,
        0,
      ) +
      contracts.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "error").length,
        0,
      );
    const warningCount =
      results.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "warning").length,
        0,
      ) +
      compositions.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "warning").length,
        0,
      ) +
      contracts.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "warning").length,
        0,
      );
    const infoCount =
      results.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "info").length,
        0,
      ) +
      compositions.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "info").length,
        0,
      ) +
      contracts.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "info").length,
        0,
      );

    const harness = parsed.mode
      ? harnessGate(parsed.mode, {
          files: results.length,
          compositions: compositions.length,
          contracts: contracts.length,
        })
      : undefined;
    const missingEvidenceCount = harness?.missingEvidence.length ?? 0;
    const payload = {
      ok: errorCount === 0 && missingEvidenceCount === 0,
      counts: { error: errorCount, warning: warningCount, info: infoCount },
      files: results,
      compositions,
      contracts,
      ...(harness !== undefined ? { harness } : {}),
    };

    process.stdout.write(
      `${JSON.stringify(parsed.format === "sarif" ? toSarif(results, compositions, contracts, harness) : payload, null, 2)}\n`,
    );
    return errorCount === 0 && missingEvidenceCount === 0 ? 0 : 1;
  } finally {
    await source.stop();
  }
}

function parseArgs(argv: string[]): CliOptions | { error: string } {
  const files: string[] = [];
  const compositions: string[] = [];
  const contracts: string[] = [];
  let sourcePath = process.env.DS_MCP_SOURCE_PATH;
  let language: RuleLanguage | undefined;
  let rules: string[] = [];
  let format: "json" | "sarif" = "json";
  let mode: HarnessMode | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      // pnpm forwards the script argument separator; ignore it.
    } else if (arg === "--source") {
      sourcePath = readValue(argv, ++i, "--source");
    } else if (arg === "--language") {
      const raw = readValue(argv, ++i, "--language");
      const result = RuleLanguageSchema.safeParse(raw);
      if (!result.success) return { error: `unsupported language: ${raw}` };
      language = result.data;
    } else if (arg === "--rules") {
      rules = readValue(argv, ++i, "--rules")
        .split(",")
        .map((rule) => rule.trim())
        .filter(Boolean);
    } else if (arg === "--format") {
      const raw = readValue(argv, ++i, "--format");
      if (raw !== "json" && raw !== "sarif") return { error: "supported formats: json, sarif" };
      format = raw;
    } else if (arg === "--mode") {
      const raw = readValue(argv, ++i, "--mode");
      const result = HarnessModeSchema.safeParse(raw);
      if (!result.success) {
        return {
          error: "supported modes: plan_only, generate, validate, repair, final_check",
        };
      }
      mode = result.data;
    } else if (arg === "--composition") {
      compositions.push(readValue(argv, ++i, "--composition"));
    } else if (arg === "--contract") {
      contracts.push(readValue(argv, ++i, "--contract"));
    } else if (arg === "--help" || arg === "-h") {
      return { error: usage() };
    } else if (arg?.startsWith("--")) {
      return { error: `unknown option: ${arg}` };
    } else if (arg) {
      files.push(arg);
    }
  }

  if (!sourcePath) return { error: "missing --source or DS_MCP_SOURCE_PATH" };
  if (files.length === 0 && compositions.length === 0 && contracts.length === 0) {
    return {
      error: "missing file path(s), --composition plan(s), or --contract evidence to validate",
    };
  }

  return {
    sourcePath: path.resolve(sourcePath),
    files,
    compositions,
    contracts,
    language,
    rules,
    format,
    mode,
  };
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function inferLanguage(filePath: string): RuleLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".ts":
      return "ts";
    case ".js":
      return "js";
    case ".css":
      return "css";
    case ".html":
    case ".htm":
      return "html";
    case ".vue":
      return "vue";
    case ".swift":
      return "swift";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".dart":
      return "dart";
    default:
      return "tsx";
  }
}

function usage(): string {
  return [
    "Usage: ds-mcp-validate --source <design-system-repo> [--language tsx] [--rules a,b] [--format json|sarif] [--mode validate|final_check] [--composition plan.json] [--contract handoff.json] <file...>",
    "",
    "Outputs JSON or SARIF. Exits 1 when any error-severity code/composition violation or harness-gate failure is found.",
  ].join("\n");
}

function harnessGate(
  mode: HarnessMode,
  counts: { files: number; compositions: number; contracts: number },
): { mode: HarnessMode; missingEvidence: string[] } {
  const missingEvidence: string[] = [];
  if (["validate", "repair", "final_check"].includes(mode) && counts.files === 0) {
    missingEvidence.push("validate_ui");
  }
  if (["plan_only", "generate", "validate", "repair", "final_check"].includes(mode)) {
    if (counts.compositions === 0) missingEvidence.push("validate_composition");
  }
  if (mode === "final_check" && counts.contracts === 0) {
    missingEvidence.push("validate_design_contract");
  }
  return { mode, missingEvidence };
}

function toSarif(
  results: FileResult[],
  compositions: CompositionResult[],
  contracts: ContractResult[],
  harness?: { mode: HarnessMode; missingEvidence: string[] } | undefined,
): Record<string, unknown> {
  const rules = new Map<string, { id: string; shortDescription: { text: string } }>();
  const sarifResults: Array<Record<string, unknown>> = [];

  for (const file of results) {
    for (const violation of file.violations) {
      rules.set(violation.ruleId, {
        id: violation.ruleId,
        shortDescription: { text: violation.message },
      });
      sarifResults.push({
        ruleId: violation.ruleId,
        level: sarifLevel(violation.severity),
        message: { text: violation.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: file.path },
              region: {
                startLine: violation.line ?? 1,
                startColumn: violation.column ?? 1,
              },
            },
          },
        ],
        properties: {
          severity: violation.severity,
          match: violation.match,
          suggestion: violation.suggestion,
          replaceWith: violation.replaceWith,
          repair: violation.repair,
          provenance: violation.provenance,
        },
      });
    }
  }

  for (const file of compositions) {
    for (const violation of file.violations) {
      const ruleId = `composition/${violation.entityId}`;
      rules.set(ruleId, {
        id: ruleId,
        shortDescription: { text: violation.message },
      });
      sarifResults.push({
        ruleId,
        level: sarifLevel(violation.severity),
        message: { text: violation.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: file.path },
              region: { startLine: 1, startColumn: 1 },
            },
          },
        ],
        properties: {
          kind: "composition",
          severity: violation.severity,
          entityId: violation.entityId,
          path: violation.path,
          suggestion: violation.suggestion,
        },
      });
    }
  }

  for (const file of contracts) {
    for (const violation of file.violations) {
      const ruleId = `contract/${violation.ruleId}`;
      rules.set(ruleId, {
        id: ruleId,
        shortDescription: { text: violation.message },
      });
      sarifResults.push({
        ruleId,
        level: sarifLevel(violation.severity),
        message: { text: violation.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: file.path },
              region: { startLine: 1, startColumn: 1 },
            },
          },
        ],
        properties: {
          kind: "contract",
          severity: violation.severity,
          path: violation.path,
          suggestion: violation.suggestion,
          sourceEntity: violation.sourceEntity,
        },
      });
    }
  }

  if (harness && harness.missingEvidence.length > 0) {
    const ruleId = "harness/missing-evidence";
    rules.set(ruleId, {
      id: ruleId,
      shortDescription: { text: "Required design-system harness validation evidence is missing." },
    });
    sarifResults.push({
      ruleId,
      level: "error",
      message: {
        text: `${harness.mode} is missing required evidence: ${harness.missingEvidence.join(", ")}.`,
      },
      locations: [],
      properties: {
        kind: "harness",
        mode: harness.mode,
        missingEvidence: harness.missingEvidence,
      },
    });
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "ds-mcp-validate",
            informationUri: "https://github.com/pghoshal/design-system-mcp",
            rules: [...rules.values()],
          },
        },
        results: sarifResults,
      },
    ],
  };
}

function sarifLevel(severity: string): "error" | "warning" | "note" {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "note";
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
