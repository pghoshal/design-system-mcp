import { promises as fs } from "node:fs";
import path from "node:path";
import pino from "pino";
import { RuleLanguageSchema } from "./bundle/schema.js";
import type { RuleLanguage } from "./bundle/types.js";
import { LocalSourceAdapter } from "./source/local.js";
import { SourceManager } from "./source/manager.js";
import {
  ValidateCompositionInput,
  handler as validateCompositionHandler,
} from "./tools/validate-composition.js";
import { handler as validateUiHandler } from "./tools/validate-ui.js";
import { LayeredCache } from "./util/lru.js";

interface CliOptions {
  sourcePath: string;
  files: string[];
  compositions: string[];
  language?: RuleLanguage | undefined;
  rules: string[];
  format: "json" | "sarif";
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

    const errorCount =
      results.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "error").length,
        0,
      ) +
      compositions.reduce(
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
      );
    const infoCount =
      results.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "info").length,
        0,
      ) +
      compositions.reduce(
        (count, file) => count + file.violations.filter((v) => v.severity === "info").length,
        0,
      );

    const payload = {
      ok: errorCount === 0,
      counts: { error: errorCount, warning: warningCount, info: infoCount },
      files: results,
      compositions,
    };

    process.stdout.write(
      `${JSON.stringify(parsed.format === "sarif" ? toSarif(results, compositions) : payload, null, 2)}\n`,
    );
    return errorCount === 0 ? 0 : 1;
  } finally {
    await source.stop();
  }
}

function parseArgs(argv: string[]): CliOptions | { error: string } {
  const files: string[] = [];
  const compositions: string[] = [];
  let sourcePath = process.env.DS_MCP_SOURCE_PATH;
  let language: RuleLanguage | undefined;
  let rules: string[] = [];
  let format: "json" | "sarif" = "json";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
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
    } else if (arg === "--composition") {
      compositions.push(readValue(argv, ++i, "--composition"));
    } else if (arg === "--help" || arg === "-h") {
      return { error: usage() };
    } else if (arg?.startsWith("--")) {
      return { error: `unknown option: ${arg}` };
    } else if (arg) {
      files.push(arg);
    }
  }

  if (!sourcePath) return { error: "missing --source or DS_MCP_SOURCE_PATH" };
  if (files.length === 0 && compositions.length === 0) {
    return { error: "missing file path(s) or --composition plan(s) to validate" };
  }

  return { sourcePath: path.resolve(sourcePath), files, compositions, language, rules, format };
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
    default:
      return "tsx";
  }
}

function usage(): string {
  return [
    "Usage: ds-mcp-validate --source <design-system-repo> [--language tsx] [--rules a,b] [--format json|sarif] [--composition plan.json] <file...>",
    "",
    "Outputs JSON or SARIF. Exits 1 when any error-severity code or composition violation is found.",
  ].join("\n");
}

function toSarif(
  results: FileResult[],
  compositions: CompositionResult[],
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
