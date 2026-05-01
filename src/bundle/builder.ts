import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { Logger } from "../observability/logger.js";
import { buildSearchIndex } from "../search/minisearch.js";
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

  const [tokenResult, mdEntities, promptResult, rules] = await Promise.all([
    loadTokens(sourcePath, logger),
    loadMarkdown(sourcePath, logger),
    loadPrompts(sourcePath, logger),
    loadRules(sourcePath, logger),
  ]);

  const allEntities: Entity[] = [...tokenResult.entities, ...mdEntities, ...promptResult.entities];

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
      relations.add({ from: ent.id, to: target, type: "related" });
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
      prompts: promptResult.prompts.length,
      rules: rules.length,
      manifestSource: manifest.source,
      gitSha,
    },
    "bundle built",
  );

  return bundle;
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
