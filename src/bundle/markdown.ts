import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { Logger } from "../observability/logger.js";
import { FrontmatterSchema, PatternContractSchema, PromptFrontmatterSchema } from "./schema.js";
import type { Entity, PromptTemplate } from "./types.js";

interface MdSourceConfig {
  /** Subdirectory under repoPath, e.g. "docs/principles". */
  dir: string;
  /** Default entity type if frontmatter does not specify one. */
  defaultType: string;
}

interface StructuredMarkdownDoc {
  do?: string[] | undefined;
  dont?: string[] | undefined;
  accessibility?: string[] | undefined;
  migration?: string[] | undefined;
  propTables?: StructuredPropTable[] | undefined;
}

interface StructuredPropTable {
  columns: string[];
  rows: StructuredPropRow[];
}

interface StructuredPropRow {
  name: string;
  type?: string | undefined;
  required?: boolean | undefined;
  default?: string | undefined;
  description?: string | undefined;
  cells: Record<string, string>;
}

type StructuredSectionKind = "do" | "dont" | "accessibility" | "migration" | "props";

const MD_SOURCES: readonly MdSourceConfig[] = [
  { dir: "docs/principles", defaultType: "principle" },
  { dir: "docs/patterns", defaultType: "pattern" },
  { dir: "docs/conventions", defaultType: "convention" },
];

export const COMMUNITY_DOC_FILE_NAMES = new Set([
  "getdesign.md",
  "getdesign.mdx",
  "design-system.md",
  "design-system.mdx",
  "design.md",
  "design.mdx",
  "styleguide.md",
  "styleguide.mdx",
  "guidelines.md",
  "guidelines.mdx",
]);

/**
 * Loads markdown content from canonical doc directories and community root docs into entities.
 * - frontmatter `id`, `type`, `summary`, `tags` override defaults
 * - id defaults to `<type>:<filename-without-ext>`
 * - summary defaults to first non-heading paragraph (trimmed) or filename
 */
export async function loadMarkdown(repoPath: string, logger: Logger): Promise<Entity[]> {
  const entities: Entity[] = [];

  for (const src of MD_SOURCES) {
    const dirAbs = path.join(repoPath, src.dir);
    if (!(await dirExists(dirAbs))) continue;
    const files = await listDocFiles(dirAbs);
    for (const file of files) {
      const ent = await readMdEntity(file, repoPath, src.defaultType, logger);
      if (ent) entities.push(ent);
    }
  }

  entities.push(...(await loadCommunityDocs(repoPath, logger)));

  // voice-and-tone.md — single file mapped to one voice entity (top-level summary)
  const voicePath = path.join(repoPath, "docs/voice-and-tone.md");
  if (await fileExists(voicePath)) {
    const ent = await readMdEntity(voicePath, repoPath, "voice", logger);
    if (ent) entities.push(ent);
  }

  logger.info({ count: entities.length }, "loaded markdown entities");
  return entities;
}

async function loadCommunityDocs(repoPath: string, logger: Logger): Promise<Entity[]> {
  const entries = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => []);
  const entities: Entity[] = [];

  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || !isDocFileName(ent.name)) continue;

    const filePath = path.join(repoPath, ent.name);
    if (!(await shouldLoadCommunityDoc(filePath, ent.name))) continue;

    const entity = await readMdEntity(filePath, repoPath, "convention", logger);
    if (entity) entities.push(entity);
  }

  return entities;
}

async function shouldLoadCommunityDoc(filePath: string, fileName: string): Promise<boolean> {
  if (COMMUNITY_DOC_FILE_NAMES.has(fileName.toLowerCase())) return true;

  const raw = await fs.readFile(filePath, "utf8");
  const { data } = matter(raw);
  return typeof data.id === "string" || typeof data.type === "string" || isRecord(data.tokens);
}

async function readMdEntity(
  filePath: string,
  repoPath: string,
  defaultType: string,
  logger: Logger,
): Promise<Entity | null> {
  const raw = await fs.readFile(filePath, "utf8");
  const { data, content } = matter(raw);
  const body = normalizeMarkdownBody(content, path.extname(filePath) === ".mdx");

  const fmResult = FrontmatterSchema.safeParse(data ?? {});
  const fm = fmResult.success ? fmResult.data : { tags: [] };

  const baseName = path.basename(filePath, path.extname(filePath));
  // Strip leading numeric ordering like "01-" so ids are stable across reorderings.
  const slug = baseName.replace(/^\d+[-_]/, "");

  const type = (fm.type as string | undefined) ?? defaultType;
  const id = (fm.id as string | undefined) ?? `${type}:${slug}`;
  const title = (fm.title as string | undefined) ?? humanizeSlug(slug);
  const summary = (fm.summary as string | undefined) ?? deriveSummary(body) ?? title;
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  const dataRecord: Record<string, unknown> = { title, body };
  const structured = extractStructuredMarkdown(content, body);
  if (structured !== undefined) {
    dataRecord.structured = structured;
  }

  if (type === "pattern" && fm.contract !== undefined) {
    const contractResult = PatternContractSchema.safeParse(fm.contract);
    if (contractResult.success) {
      dataRecord.contract = contractResult.data;
    } else {
      logger.warn(
        { file: path.relative(repoPath, filePath), errors: contractResult.error.format() },
        "pattern contract invalid; skipping contract",
      );
    }
  }

  return {
    id,
    type,
    summary,
    tags,
    data: dataRecord,
    related: fm.related,
    source: { path: path.relative(repoPath, filePath) },
  };
}

export async function loadPrompts(
  repoPath: string,
  logger: Logger,
): Promise<{ prompts: PromptTemplate[]; entities: Entity[] }> {
  const dir = path.join(repoPath, "prompts");
  if (!(await dirExists(dir))) return { prompts: [], entities: [] };

  const files = await listPromptFiles(dir);
  const prompts: PromptTemplate[] = [];
  const entities: Entity[] = [];

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const { data, content } = matter(raw);
    const fm = PromptFrontmatterSchema.safeParse(data ?? {});
    if (!fm.success) {
      logger.warn(
        { file: path.relative(repoPath, file), errors: fm.error.format() },
        "prompt frontmatter invalid; skipping",
      );
      continue;
    }
    prompts.push({
      name: fm.data.name,
      description: fm.data.description,
      arguments: fm.data.arguments,
      body: content.trim(),
    });
    entities.push({
      id: `prompt:${fm.data.name}`,
      type: "prompt",
      summary: fm.data.description ?? `Prompt: ${fm.data.name}`,
      tags: ["prompt"],
      data: {
        name: fm.data.name,
        description: fm.data.description,
        arguments: fm.data.arguments,
        body: content.trim(),
      },
      source: { path: path.relative(repoPath, file) },
    });
  }

  logger.info({ count: prompts.length }, "loaded prompts");
  return { prompts, entities };
}

function deriveSummary(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("```")) continue;
    return trimmed.slice(0, 240);
  }
  return undefined;
}

function extractStructuredMarkdown(
  rawContent: string,
  normalizedBody: string,
): StructuredMarkdownDoc | undefined {
  const out: StructuredMarkdownDoc = {};

  for (const pair of extractMdxDoDont(stripFencedCodeBlocks(rawContent))) {
    appendUnique(out, "do", pair.doText);
    appendUnique(out, "dont", pair.dontText);
  }

  for (const section of splitMarkdownSections(normalizedBody)) {
    const kind = classifyStructuredSection(section.title);
    if (kind === undefined) continue;
    if (kind === "props") {
      const tables = extractPropTables(section.body);
      if (tables.length > 0) out.propTables = [...(out.propTables ?? []), ...tables];
      continue;
    }

    for (const item of extractListItems(section.body)) {
      appendUnique(out, kind, item);
    }
  }

  return hasStructuredMarkdown(out) ? out : undefined;
}

function extractMdxDoDont(content: string): Array<{ doText: string; dontText: string }> {
  const out: Array<{ doText: string; dontText: string }> = [];
  const re = /<DoDont\b([\s\S]*?)(?:\/>|>[\s\S]*?<\/DoDont>)/g;
  for (const match of content.matchAll(re)) {
    const attrs = readMdxAttributes(match[1] ?? "");
    const doText = attrs.get("doText");
    const dontText = attrs.get("dontText") ?? attrs.get("don'tText");
    if (doText && dontText) out.push({ doText, dontText });
  }
  return out;
}

function readMdxAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re =
    /([A-Za-z_$][\w$-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|\{\s*`([^`]*)`\s*\})/g;
  for (const match of source.matchAll(re)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
    if (name !== undefined && value !== undefined) attrs.set(name, cleanMarkdownText(value));
  }
  return attrs;
}

function splitMarkdownSections(
  content: string,
): Array<{ title: string; level: number; body: string }> {
  const topLevelSections: Array<{ title: string; level: number; body: string[] }> = [];
  const lines = content.split("\n");
  let current: { title: string; level: number; body: string[] } | undefined;
  let fenced = false;
  let fenceMarker: string | undefined;
  let fenceLength = 0;

  for (const line of lines) {
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const sequence = fence[2] ?? "";
      const marker = sequence[0];
      if (!fenced) {
        fenced = true;
        fenceMarker = marker;
        fenceLength = sequence.length;
      } else if (marker === fenceMarker && sequence.length >= fenceLength) {
        fenced = false;
        fenceMarker = undefined;
        fenceLength = 0;
      }
      continue;
    }

    if (fenced) continue;

    const heading = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const title = heading[2] ?? "";
      if (current === undefined || level <= current.level) {
        if (current) topLevelSections.push(current);
        current = { title, level, body: [] };
        continue;
      }

      current.body.push(line);
      continue;
    }
    current?.body.push(line);
  }

  if (current) topLevelSections.push(current);
  return topLevelSections.map((section) => ({
    title: section.title,
    level: section.level,
    body: section.body.join("\n"),
  }));
}

function stripFencedCodeBlocks(content: string): string {
  const out: string[] = [];
  let fenced = false;
  let fenceMarker: string | undefined;
  let fenceLength = 0;

  for (const line of content.split("\n")) {
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const sequence = fence[2] ?? "";
      const marker = sequence[0];
      if (!fenced) {
        fenced = true;
        fenceMarker = marker;
        fenceLength = sequence.length;
      } else if (marker === fenceMarker && sequence.length >= fenceLength) {
        fenced = false;
        fenceMarker = undefined;
        fenceLength = 0;
      }
      continue;
    }
    if (!fenced) out.push(line);
  }

  return out.join("\n");
}

function classifyStructuredSection(title: string): StructuredSectionKind | undefined {
  const normalized = title
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(do|dos|do this|recommended|recommendations)$/.test(normalized)) return "do";
  if (/^(dont|do not|avoid|anti patterns|anti-patterns|never)$/.test(normalized)) return "dont";
  if (/^(accessibility|a11y|screen reader|screen readers)$/.test(normalized))
    return "accessibility";
  if (/^(migration|migrations|migrate|upgrade|upgrades|migration notes)$/.test(normalized)) {
    return "migration";
  }
  if (/^(prop|props|properties|api|component api)$/.test(normalized)) return "props";
  return undefined;
}

function extractListItems(sectionBody: string): string[] {
  const items: string[] = [];
  for (const line of sectionBody.split("\n")) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) items.push(cleanMarkdownText(match[1]));
  }
  return items.filter((item) => item.length > 0);
}

function extractPropTables(sectionBody: string): StructuredPropTable[] {
  const tables: StructuredPropTable[] = [];
  const lines = sectionBody.split("\n");

  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i]?.trim() ?? "";
    const separator = lines[i + 1]?.trim() ?? "";
    if (!isMarkdownTableRow(header) || !isMarkdownTableSeparator(separator)) continue;

    const columns = splitMarkdownTableRow(header).map(cleanMarkdownText);
    const rows: StructuredPropRow[] = [];
    i += 2;

    while (i < lines.length && isMarkdownTableRow(lines[i]?.trim() ?? "")) {
      if (i + 1 < lines.length && isMarkdownTableSeparator(lines[i + 1]?.trim() ?? "")) break;
      const values = splitMarkdownTableRow(lines[i] ?? "").map(cleanMarkdownText);
      const row = buildPropRow(columns, values);
      if (row) rows.push(row);
      i++;
    }
    i--;

    if (rows.length > 0) tables.push({ columns, rows });
  }

  return tables;
}

function buildPropRow(columns: string[], values: string[]): StructuredPropRow | undefined {
  const cells: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (!column) continue;
    cells[column] = values[i] ?? "";
  }

  const name = valueForColumns(cells, ["prop", "property", "name"]);
  if (!name) return undefined;

  const row: StructuredPropRow = { name, cells };
  const type = valueForColumns(cells, ["type"]);
  const required = valueForColumns(cells, ["required", "is required"]);
  const defaultValue = valueForColumns(cells, ["default", "default value"]);
  const description = valueForColumns(cells, ["description", "notes", "usage"]);

  if (type) row.type = type;
  if (required) row.required = /^(yes|true|required)$/i.test(required);
  if (defaultValue) row.default = defaultValue;
  if (description) row.description = description;
  return row;
}

function valueForColumns(cells: Record<string, string>, names: string[]): string | undefined {
  for (const [key, value] of Object.entries(cells)) {
    const normalized = key
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim();
    if (names.includes(normalized) && value.length > 0) return value;
  }
  return undefined;
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && splitMarkdownTableRow(line).length > 1;
}

function isMarkdownTableSeparator(line: string): boolean {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char === "|" ? "\\|" : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function appendUnique(
  out: StructuredMarkdownDoc,
  key: Exclude<StructuredSectionKind, "props">,
  value: string,
): void {
  const cleaned = cleanMarkdownText(value);
  if (!cleaned) return;
  const existing = out[key] ?? [];
  if (!existing.includes(cleaned)) out[key] = [...existing, cleaned];
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/\\\|/g, "|")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasStructuredMarkdown(doc: StructuredMarkdownDoc): boolean {
  return (
    (doc.do?.length ?? 0) > 0 ||
    (doc.dont?.length ?? 0) > 0 ||
    (doc.accessibility?.length ?? 0) > 0 ||
    (doc.migration?.length ?? 0) > 0 ||
    (doc.propTables?.length ?? 0) > 0
  );
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function listDocFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listDocFiles(full)));
    } else if (ent.isFile() && isDocFileName(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

async function listPromptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listPromptFiles(full)));
    } else if (ent.isFile() && ent.name.endsWith(".prompt.md")) {
      out.push(full);
    }
  }
  return out;
}

export function isDocFileName(fileName: string): boolean {
  return (
    (fileName.endsWith(".md") || fileName.endsWith(".mdx")) &&
    !fileName.endsWith(".prompt.md") &&
    !fileName.endsWith(".prompt.mdx")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMarkdownBody(content: string, isMdx: boolean): string {
  const trimmed = content.trim();
  if (!isMdx) return trimmed;

  return stripMdxJsBlocks(trimmed)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<([A-Z][A-Za-z0-9.]*)\b[^>]*>[\s\S]*?<\/\1>/g, "")
    .replace(/<([A-Z][A-Za-z0-9.]*)\b[^>]*\/>/g, "")
    .trim();
}

function stripMdxJsBlocks(content: string): string {
  const out: string[] = [];
  const lines = content.split("\n");
  let skipping = false;
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && (trimmed.startsWith("import ") || trimmed.startsWith("export "))) {
      const delta = bracketDelta(line);
      if (delta > 0 || trimmed.endsWith(",")) {
        skipping = true;
        depth = delta;
      }
      continue;
    }

    if (skipping) {
      depth += bracketDelta(line);
      if (depth <= 0 && !trimmed.endsWith(",")) {
        skipping = false;
        depth = 0;
      }
      continue;
    }

    if (/^<[A-Z][^>]*\/?>$/.test(trimmed)) continue;
    if (/^<\/[A-Z][^>]*>$/.test(trimmed)) continue;
    out.push(line);
  }

  return out.join("\n");
}

function bracketDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "{" || char === "(" || char === "[") delta++;
    if (char === "}" || char === ")" || char === "]") delta--;
  }
  return delta;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
