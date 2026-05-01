import { promises as fs } from "node:fs";
import path from "node:path";
import pino from "pino";
import { RuleLanguageSchema } from "./bundle/schema.js";
import type { RuleLanguage } from "./bundle/types.js";
import { LocalSourceAdapter } from "./source/local.js";
import { SourceManager } from "./source/manager.js";
import { handler as validateUiHandler } from "./tools/validate-ui.js";
import { LayeredCache } from "./util/lru.js";

interface CliOptions {
  sourcePath: string;
  files: string[];
  language?: RuleLanguage | undefined;
  rules: string[];
}

interface FileResult {
  path: string;
  ok: boolean;
  violations: Awaited<ReturnType<typeof validateUiHandler.handle>>["violations"];
  ranRules: string[];
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

    const errorCount = results.reduce(
      (count, file) => count + file.violations.filter((v) => v.severity === "error").length,
      0,
    );
    const warningCount = results.reduce(
      (count, file) => count + file.violations.filter((v) => v.severity === "warning").length,
      0,
    );
    const infoCount = results.reduce(
      (count, file) => count + file.violations.filter((v) => v.severity === "info").length,
      0,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: errorCount === 0,
          counts: { error: errorCount, warning: warningCount, info: infoCount },
          files: results,
        },
        null,
        2,
      )}\n`,
    );
    return errorCount === 0 ? 0 : 1;
  } finally {
    await source.stop();
  }
}

function parseArgs(argv: string[]): CliOptions | { error: string } {
  const files: string[] = [];
  let sourcePath = process.env.DS_MCP_SOURCE_PATH;
  let language: RuleLanguage | undefined;
  let rules: string[] = [];

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
      const format = readValue(argv, ++i, "--format");
      if (format !== "json") return { error: "only --format json is supported" };
    } else if (arg === "--help" || arg === "-h") {
      return { error: usage() };
    } else if (arg?.startsWith("--")) {
      return { error: `unknown option: ${arg}` };
    } else if (arg) {
      files.push(arg);
    }
  }

  if (!sourcePath) return { error: "missing --source or DS_MCP_SOURCE_PATH" };
  if (files.length === 0) return { error: "missing file path(s) to validate" };

  return { sourcePath: path.resolve(sourcePath), files, language, rules };
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
    "Usage: ds-mcp-validate --source <design-system-repo> [--language tsx] [--rules a,b] <file...>",
    "",
    "Outputs JSON. Exits 1 when any error-severity violation is found.",
  ].join("\n");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
