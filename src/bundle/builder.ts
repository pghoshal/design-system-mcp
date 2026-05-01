import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { Logger } from "../observability/logger.js";
import { buildSearchIndex } from "../search/minisearch.js";
import { loadComponents } from "./components.js";
import { loadManifest } from "./manifest.js";
import { loadMarkdown, loadPrompts } from "./markdown.js";
import { loadRules } from "./rules.js";
import { loadTokens } from "./tokens.js";
import { type Bundle, type Entity, RelationsIndex } from "./types.js";

export interface BuildBundleOptions {
  /** Filesystem path to a checkout of the design-system repo. */
  sourcePath: string;
  logger: Logger;
}

/**
 * Builds an in-memory Bundle from a design-system repo checkout.
 * The build is read-only and idempotent: same checkout → same bundle (modulo `builtAt`).
 */
export async function buildBundle(opts: BuildBundleOptions): Promise<Bundle> {
  const { sourcePath, logger } = opts;
  const start = Date.now();

  const manifest = await loadManifest(sourcePath, logger);

  const [tokenResult, mdEntities, componentEntities, promptResult, rules] = await Promise.all([
    loadTokens(sourcePath, logger),
    loadMarkdown(sourcePath, logger),
    loadComponents(sourcePath, logger),
    loadPrompts(sourcePath, logger),
    loadRules(sourcePath, logger),
  ]);

  const allEntities: Entity[] = [
    ...tokenResult.entities,
    ...mdEntities,
    ...componentEntities,
    ...promptResult.entities,
  ];

  const entityMap = new Map<string, Entity>();
  const duplicates: string[] = [];
  for (const ent of allEntities) {
    if (entityMap.has(ent.id)) {
      duplicates.push(ent.id);
      continue;
    }
    entityMap.set(ent.id, ent);
  }
  if (duplicates.length > 0) {
    logger.warn({ duplicates }, "duplicate entity ids; first occurrence kept");
  }

  const relations = new RelationsIndex();
  for (const ent of entityMap.values()) {
    if (!ent.related) continue;
    for (const target of ent.related) {
      if (!entityMap.has(target)) {
        logger.warn({ from: ent.id, to: target }, "relation target not found");
        continue;
      }
      relations.add({ from: ent.id, to: target, type: relationTypeFor(ent, target) });
    }
  }
  for (const ent of entityMap.values()) {
    for (const target of inferReferencedEntityIds(ent, entityMap)) {
      relations.add({ from: ent.id, to: target, type: "references" });
    }
  }

  const searchIndex = buildSearchIndex(entityMap, manifest.schema);

  const gitSha = await tryGetGitSha(sourcePath, logger);
  const builtAt = new Date().toISOString();
  const version = `${gitSha ?? "nogit"}-${builtAt}`;

  const bundle: Bundle = {
    version,
    schemaVersion: manifest.schemaVersion,
    builtAt,
    gitSha: gitSha ?? undefined,
    sourcePath,
    entities: entityMap,
    schema: manifest.schema,
    relations,
    searchIndex,
    tokensResolved: tokenResult.tokensResolved,
    prompts: promptResult.prompts,
    rules,
  };

  logger.info(
    {
      durationMs: Date.now() - start,
      entityCount: entityMap.size,
      tokens: tokenResult.entities.length,
      markdown: mdEntities.length,
      components: componentEntities.length,
      prompts: promptResult.prompts.length,
      rules: rules.length,
      manifestSource: manifest.source,
      gitSha,
    },
    "bundle built",
  );

  return bundle;
}

function relationTypeFor(ent: Entity, target: string): string {
  if (ent.type !== "component") return "related";
  const data = ent.data as {
    tokens?: string[] | undefined;
    principles?: string[] | undefined;
    patterns?: string[] | undefined;
  };
  if (data.tokens?.includes(target)) return "uses_token";
  if (data.principles?.includes(target)) return "follows_principle";
  if (data.patterns?.includes(target)) return "implements_pattern";
  return "related";
}

function inferReferencedEntityIds(ent: Entity, entityMap: ReadonlyMap<string, Entity>): string[] {
  const text = entityReferenceText(ent);
  if (!text) return [];

  const out: string[] = [];
  for (const id of entityMap.keys()) {
    if (id === ent.id) continue;
    if (containsEntityId(text, id)) out.push(id);
  }
  return out;
}

function entityReferenceText(ent: Entity): string {
  const chunks = [ent.summary, ent.tags.join(" ")];
  const data = ent.data;
  for (const key of ["title", "name", "body"] as const) {
    const value = data[key];
    if (typeof value === "string") chunks.push(value);
  }
  collectArrayText(data.examples, chunks);
  collectArrayText(data.constraints, chunks);
  collectArrayText(data.props, chunks);
  return chunks.join("\n");
}

function containsEntityId(text: string, id: string): boolean {
  const escaped = escapeRegExp(id);
  const re = new RegExp(`(^|[^A-Za-z0-9:._-])${escaped}($|[^A-Za-z0-9:._-])`);
  return re.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectArrayText(value: unknown, chunks: string[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") {
      chunks.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    for (const nested of Object.values(item as Record<string, unknown>)) {
      if (typeof nested === "string") chunks.push(nested);
      if (Array.isArray(nested)) chunks.push(nested.filter((v) => typeof v === "string").join(" "));
    }
  }
}

async function tryGetGitSha(repoPath: string, logger: Logger): Promise<string | null> {
  try {
    const gitDir = path.join(repoPath, ".git");
    const stat = await fs.stat(gitDir).catch(() => null);
    if (!stat) return null;
    const git = simpleGit(repoPath);
    const sha = (await git.revparse(["HEAD"])).trim();
    return sha.slice(0, 7);
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "git sha unavailable");
    return null;
  }
}
