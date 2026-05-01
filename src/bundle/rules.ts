import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import { RuleSchema } from "./schema.js";
import type { Rule } from "./types.js";

/**
 * Loads validation rules from `<repoPath>/rules/*.json`.
 * Invalid rules log a warning and are skipped — never fatal.
 * Duplicate IDs: first wins (filename order).
 */
export async function loadRules(repoPath: string, logger: Logger): Promise<Rule[]> {
  const dir = path.join(repoPath, "rules");
  if (!(await dirExists(dir))) {
    logger.debug({ dir }, "no rules/ directory");
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();

  const out: Rule[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      logger.warn(
        { file: path.relative(repoPath, file), err: (err as Error).message },
        "rule: read failed",
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { file: path.relative(repoPath, file), err: (err as Error).message },
        "rule: invalid JSON, skipping",
      );
      continue;
    }

    const result = RuleSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(
        { file: path.relative(repoPath, file), errors: result.error.format() },
        "rule: schema validation failed, skipping",
      );
      continue;
    }

    if (result.data.detector.type === "regex") {
      try {
        new RegExp(result.data.detector.pattern, result.data.detector.flags);
      } catch (err) {
        logger.warn(
          { file: path.relative(repoPath, file), err: (err as Error).message },
          "rule: invalid regex detector, skipping",
        );
        continue;
      }
    }

    if (seen.has(result.data.id)) {
      logger.warn(
        { id: result.data.id, file: path.relative(repoPath, file) },
        "rule: duplicate id, keeping first occurrence",
      );
      continue;
    }
    seen.add(result.data.id);
    out.push(result.data as Rule);
  }

  logger.info({ count: out.length, scanned: files.length }, "loaded rules");
  return out;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
