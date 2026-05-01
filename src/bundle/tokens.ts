import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import StyleDictionary from "style-dictionary";
import type { Logger } from "../observability/logger.js";
import { COMMUNITY_DOC_FILE_NAMES, isDocFileName } from "./markdown.js";
import type { Entity } from "./types.js";

export interface TokenLoadResult {
  /** Resolved nested token tree (DTCG-formatted, references resolved). */
  tokensResolved: Record<string, unknown>;
  /** One Entity per leaf token. */
  entities: Entity[];
}

/**
 * Loads DTCG tokens from `<repoPath>/tokens/**\/*.tokens.json` and Markdown
 * frontmatter `tokens:` blocks via Style Dictionary v4.
 * Resolves `{ref}` references into concrete values, then walks the dictionary to emit
 * one entity per token leaf with id `token:<dot.path>`.
 *
 * If no token files are present, returns an empty result (no error).
 */
export async function loadTokens(repoPath: string, logger: Logger): Promise<TokenLoadResult> {
  const tokensDir = path.join(repoPath, "tokens");
  const files = (await dirExists(tokensDir)) ? await findTokenFiles(tokensDir) : [];
  const markdownTokenSources = await extractMarkdownTokenSources(repoPath, logger);
  const sourceFiles = [...sortByRelativePath(files, repoPath), ...markdownTokenSources.files];

  if (files.length === 0) {
    logger.debug({ tokensDir }, "no token json files found");
  }
  if (sourceFiles.length === 0) {
    logger.debug({ tokensDir }, "no token sources found; skipping");
    return { tokensResolved: {}, entities: [] };
  }

  const sd = new StyleDictionary({
    log: { verbosity: "silent", warnings: "disabled", errors: { brokenReferences: "throw" } },
    source: sourceFiles,
    platforms: {
      // A no-transform platform exists solely so we can call getPlatformTokens()
      // and get a Dictionary with refs resolved.
      raw: {},
    },
  });

  try {
    await sd.hasInitialized;
    const dict = await sd.getPlatformTokens("raw");

    const entities: Entity[] = [];
    for (const tok of dict.allTokens) {
      const id = `token:${tok.path.join(".")}`;
      const tokenType = (tok.$type ?? tok.type) as string | undefined;
      const description = (tok.$description ?? tok.comment ?? "") as string;
      const rawValue = tok.$value ?? tok.value;
      const deprecated = tok.$deprecated ?? tok.deprecated;
      const replacement = tok.$replacement ?? tok.replacement;
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
          ...(deprecated !== undefined ? { deprecated } : {}),
          ...(replacement !== undefined ? { replacement } : {}),
        },
        source: {
          path:
            markdownTokenSources.sourcePathByFile.get(tok.filePath) ??
            relativeToRepo(tok.filePath, repoPath),
        },
      });
    }

    logger.info(
      { count: entities.length, markdownSources: markdownTokenSources.sourcePathByFile.size },
      "loaded tokens",
    );
    return { tokensResolved: dict.tokens as Record<string, unknown>, entities };
  } finally {
    await markdownTokenSources.cleanup();
  }
}

interface MarkdownTokenSources {
  files: string[];
  sourcePathByFile: Map<string, string>;
  cleanup: () => Promise<void>;
}

async function extractMarkdownTokenSources(
  repoPath: string,
  logger: Logger,
): Promise<MarkdownTokenSources> {
  const markdownFiles = await listMarkdownTokenCandidateFiles(repoPath);
  const tokenFiles: string[] = [];
  const sourcePathByFile = new Map<string, string>();
  let tmpDir: string | undefined;

  for (const filePath of markdownFiles) {
    const raw = await fs.readFile(filePath, "utf8");
    const { data } = matter(raw);
    if (!isRecord(data.tokens)) continue;

    const normalized = normalizeMarkdownTokens(data.tokens);
    if (!isRecord(normalized)) continue;

    tmpDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-md-tokens-"));
    const rel = path.relative(repoPath, filePath);
    const outFile = path.join(tmpDir, `${safeFileName(rel)}.tokens.json`);
    await fs.writeFile(outFile, JSON.stringify(normalized), "utf8");
    tokenFiles.push(outFile);
    sourcePathByFile.set(outFile, rel);
  }

  if (tokenFiles.length > 0) {
    logger.info({ count: tokenFiles.length }, "loaded markdown token sources");
  }

  return {
    files: tokenFiles,
    sourcePathByFile,
    cleanup: async () => {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function listMarkdownTokenCandidateFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];

  for (const dir of ["docs/principles", "docs/patterns", "docs/conventions"]) {
    const abs = path.join(repoPath, dir);
    if (await dirExists(abs)) files.push(...(await findMarkdownFiles(abs)));
  }

  const rootEntries = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => []);
  for (const ent of rootEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || !isDocFileName(ent.name)) continue;
    const filePath = path.join(repoPath, ent.name);
    if (
      COMMUNITY_DOC_FILE_NAMES.has(ent.name.toLowerCase()) ||
      (await markdownHasTokenFrontmatter(filePath))
    ) {
      files.push(filePath);
    }
  }

  return files;
}

async function markdownHasTokenFrontmatter(filePath: string): Promise<boolean> {
  const raw = await fs.readFile(filePath, "utf8");
  const { data } = matter(raw);
  return isRecord(data.tokens);
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await findMarkdownFiles(full)));
    } else if (ent.isFile() && isDocFileName(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function sortByRelativePath(files: string[], basePath: string): string[] {
  return [...files].sort((a, b) =>
    path.relative(basePath, a).localeCompare(path.relative(basePath, b)),
  );
}

function normalizeMarkdownTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeMarkdownTokens(item));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "value") out.$value = normalizeMarkdownTokens(child);
    else if (key === "type") out.$type = child;
    else if (key === "description") out.$description = child;
    else out[key] = normalizeMarkdownTokens(child);
  }
  return out;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
