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

const MD_SOURCES: readonly MdSourceConfig[] = [
  { dir: "docs/principles", defaultType: "principle" },
  { dir: "docs/patterns", defaultType: "pattern" },
  { dir: "docs/conventions", defaultType: "convention" },
];

/**
 * Loads markdown content from canonical doc directories into entities.
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

  // voice-and-tone.md — single file mapped to one voice entity (top-level summary)
  const voicePath = path.join(repoPath, "docs/voice-and-tone.md");
  if (await fileExists(voicePath)) {
    const ent = await readMdEntity(voicePath, repoPath, "voice", logger);
    if (ent) entities.push(ent);
  }

  logger.info({ count: entities.length }, "loaded markdown entities");
  return entities;
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
    } else if (
      ent.isFile() &&
      (ent.name.endsWith(".md") || ent.name.endsWith(".mdx") || ent.name.endsWith(".prompt.md"))
    ) {
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
