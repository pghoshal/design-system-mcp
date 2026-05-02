import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import StyleDictionary from "style-dictionary";
import type { Logger } from "../observability/logger.js";
import { COMMUNITY_DOC_FILE_NAMES, isDocFileName } from "./markdown.js";
import { TokenEntityDataSchema } from "./schema.js";
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
  const jsonTokenSources = await prepareJsonTokenSources(files, repoPath, logger);
  const markdownTokenSources = await extractMarkdownTokenSources(repoPath, logger);
  const sourceFiles = [...jsonTokenSources.files, ...markdownTokenSources.files];

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

      const data = TokenEntityDataSchema.parse({
        name: tok.name,
        path: tok.path,
        value: rawValue,
        original: tok.original?.$value ?? tok.original?.value,
        $type: tokenType,
        ...(deprecated !== undefined ? { deprecated } : {}),
        ...(replacement !== undefined ? { replacement } : {}),
      });

      entities.push({
        id,
        type: "token",
        summary,
        tags: deriveTokenTags(tok.path, tokenType),
        data,
        source: {
          path:
            jsonTokenSources.sourcePathByFile.get(tok.filePath) ??
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
    await Promise.all([jsonTokenSources.cleanup(), markdownTokenSources.cleanup()]);
  }
}

interface JsonTokenSources {
  files: string[];
  sourcePathByFile: Map<string, string>;
  cleanup: () => Promise<void>;
}

interface MarkdownTokenSources {
  files: string[];
  sourcePathByFile: Map<string, string>;
  cleanup: () => Promise<void>;
}

const COMMUNITY_TOKEN_SECTIONS: Readonly<Record<string, string>> = {
  colors: "color",
  color: "color",
  spacing: "dimension",
  space: "dimension",
  rounded: "dimension",
  radius: "dimension",
  radii: "dimension",
  typography: "typography",
  components: "component",
  component: "component",
};

async function prepareJsonTokenSources(
  files: string[],
  repoPath: string,
  logger: Logger,
): Promise<JsonTokenSources> {
  const sorted = sortByRelativePath(files, repoPath);
  const parsedFiles: Array<{ file: string; rel: string; parsed: unknown }> = [];

  for (const file of sorted) {
    const raw = await fs.readFile(file, "utf8");
    parsedFiles.push({
      file,
      rel: path.relative(repoPath, file),
      parsed: parseJson(raw),
    });
  }

  const tokenSetOwners = tokenSetOwnersFor(parsedFiles.map((entry) => entry.parsed));
  const out: string[] = [];
  const sourcePathByFile = new Map<string, string>();
  let tmpDir: string | undefined;
  let normalizedCount = 0;

  for (const { file, rel, parsed } of parsedFiles) {
    if (parsed === undefined) {
      out.push(file);
      continue;
    }

    const normalized = normalizeTokenStudioReferences(parsed, tokenSetOwners);
    if (!normalized.changed) {
      out.push(file);
      continue;
    }

    tmpDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-json-tokens-"));
    const outFile = path.join(tmpDir, `${safeFileName(rel)}.tokens.json`);
    await fs.writeFile(outFile, JSON.stringify(normalized.value), "utf8");
    out.push(outFile);
    sourcePathByFile.set(outFile, rel);
    normalizedCount += 1;
  }

  if (normalizedCount > 0) {
    logger.info({ count: normalizedCount }, "normalized token studio references");
  }

  return {
    files: out,
    sourcePathByFile,
    cleanup: async () => {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
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

    const normalized = extractMarkdownTokenTree(data);
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
  return isRecord(extractMarkdownTokenTree(data));
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

function extractMarkdownTokenTree(data: unknown): unknown {
  if (!isRecord(data)) return undefined;

  const out: Record<string, unknown> = {};
  if (isRecord(data.tokens)) {
    Object.assign(out, normalizeMarkdownTokens(data.tokens));
  }

  for (const [section, tokenType] of Object.entries(COMMUNITY_TOKEN_SECTIONS)) {
    const value = data[section];
    if (!isRecord(value)) continue;
    out[section] = normalizeCommunityTokenSection(value, tokenType);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCommunityTokenSection(
  value: Record<string, unknown>,
  tokenType: string,
): unknown {
  if (tokenType === "typography" || tokenType === "component") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isDtcgToken(child)
        ? normalizeMarkdownTokens(child)
        : { $value: normalizeMarkdownTokens(child), $type: tokenType };
    }
    return out;
  }

  return normalizeCommunityTokenLeaves(value, tokenType);
}

function normalizeCommunityTokenLeaves(value: unknown, tokenType: string): unknown {
  if (isDtcgToken(value)) return normalizeMarkdownTokens(value);
  if (!isRecord(value)) return { $value: value, $type: tokenType };

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = normalizeCommunityTokenLeaves(child, tokenType);
  }
  return out;
}

function isDtcgToken(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ("$value" in value || "value" in value);
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

interface TokenSetOwner {
  set: string;
  root: unknown;
}

function tokenSetOwnersFor(values: unknown[]): TokenSetOwner[] {
  const owners: TokenSetOwner[] = [];

  for (const value of values) {
    if (!isRecord(value) || !isRecord(value.$metadata)) continue;
    for (const set of tokenSetSearchOrder(value)) {
      owners.push({ set, root: value[set] });
    }
  }

  return owners;
}

function normalizeTokenStudioReferences(
  value: unknown,
  tokenSetOwners: TokenSetOwner[],
): { value: unknown; changed: boolean } {
  if (!isRecord(value) || !isRecord(value.$metadata)) return { value, changed: false };

  if (tokenSetOwners.length === 0) return { value, changed: false };

  let changed = false;
  const rewritten = rewriteReferences(value, (ref) => {
    if (hasPath(value, ref.split("."))) return ref;

    const matches = new Set(
      tokenSetOwners
        .filter((owner) => hasPath(owner.root, ref.split(".")))
        .map((owner) => owner.set),
    );
    if (matches.size !== 1) return ref;

    changed = true;
    return `${[...matches][0]}.${ref}`;
  });

  return { value: rewritten, changed };
}

function tokenSetSearchOrder(root: Record<string, unknown>): string[] {
  const existing = Object.keys(root).filter((key) => !key.startsWith("$") && isRecord(root[key]));
  const order =
    isRecord(root.$metadata) && Array.isArray(root.$metadata.tokenSetOrder)
      ? root.$metadata.tokenSetOrder.filter((key): key is string => typeof key === "string")
      : [];
  return [
    ...order.filter((key) => existing.includes(key)),
    ...existing.filter((key) => !order.includes(key)),
  ];
}

function rewriteReferences(value: unknown, rewrite: (ref: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteReferences(item, rewrite));
  if (typeof value === "string") return rewriteReferenceString(value, rewrite);
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = rewriteReferences(child, rewrite);
  }
  return out;
}

function rewriteReferenceString(value: string, rewrite: (ref: string) => string): string {
  return value.replace(/\{([^}]+)\}/g, (match, ref: string) => {
    const next = rewrite(ref.trim());
    return next === ref.trim() ? match : `{${next}}`;
  });
}

function hasPath(value: unknown, parts: string[]): boolean {
  let current: unknown = value;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return isDtcgToken(current);
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
