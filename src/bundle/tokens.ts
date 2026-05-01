import { promises as fs } from "node:fs";
import path from "node:path";
import StyleDictionary from "style-dictionary";
import type { Logger } from "../observability/logger.js";
import type { Entity } from "./types.js";

export interface TokenLoadResult {
  /** Resolved nested token tree (DTCG-formatted, references resolved). */
  tokensResolved: Record<string, unknown>;
  /** One Entity per leaf token. */
  entities: Entity[];
}

/**
 * Loads DTCG tokens from `<repoPath>/tokens/**\/*.tokens.json` via Style Dictionary v4.
 * Resolves `{ref}` references into concrete values, then walks the dictionary to emit
 * one entity per token leaf with id `token:<dot.path>`.
 *
 * If no token files are present, returns an empty result (no error).
 */
export async function loadTokens(repoPath: string, logger: Logger): Promise<TokenLoadResult> {
  const tokensDir = path.join(repoPath, "tokens");
  if (!(await dirExists(tokensDir))) {
    logger.debug({ tokensDir }, "no tokens directory; skipping");
    return { tokensResolved: {}, entities: [] };
  }

  const files = await findTokenFiles(tokensDir);
  if (files.length === 0) {
    logger.debug({ tokensDir }, "tokens dir present but empty; skipping");
    return { tokensResolved: {}, entities: [] };
  }

  const sd = new StyleDictionary({
    log: { verbosity: "silent", warnings: "disabled", errors: { brokenReferences: "throw" } },
    source: files,
    platforms: {
      // A no-transform platform exists solely so we can call getPlatformTokens()
      // and get a Dictionary with refs resolved.
      raw: {},
    },
  });

  await sd.hasInitialized;
  const dict = await sd.getPlatformTokens("raw");

  const entities: Entity[] = [];
  for (const tok of dict.allTokens) {
    const id = `token:${tok.path.join(".")}`;
    const tokenType = (tok.$type ?? tok.type) as string | undefined;
    const description = (tok.$description ?? tok.comment ?? "") as string;
    const rawValue = tok.$value ?? tok.value;
    const summary =
      description ||
      `${tokenType ? `${tokenType} ` : ""}token ${tok.path.join(".")} = ${stringifyValue(rawValue)}`;

    entities.push({
      id,
      type: "token",
      summary,
      tags: deriveTokenTags(tok.path, tokenType),
      data: {
        name: tok.name,
        path: tok.path,
        value: rawValue,
        original: tok.original?.$value ?? tok.original?.value,
        $type: tokenType,
      },
      source: {
        path: relativeToRepo(tok.filePath, repoPath),
      },
    });
  }

  logger.info({ count: entities.length }, "loaded tokens");
  return { tokensResolved: dict.tokens as Record<string, unknown>, entities };
}

function deriveTokenTags(tokenPath: string[], tokenType: string | undefined): string[] {
  const tags = new Set<string>();
  for (const segment of tokenPath) tags.add(segment);
  if (tokenType) tags.add(tokenType);
  return [...tags];
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unstringifiable]";
  }
}

function relativeToRepo(filePath: string, repoPath: string): string {
  const rel = path.relative(repoPath, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function findTokenFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await findTokenFiles(full)));
    } else if (ent.isFile()) {
      if (ent.name.endsWith(".tokens.json") || ent.name.endsWith(".json")) {
        out.push(full);
      }
    }
  }
  return out;
}
