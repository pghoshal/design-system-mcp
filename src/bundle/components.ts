import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import { loadComponentApiProps } from "./component-api.js";
import { ComponentMetadataSchema } from "./schema.js";
import type { ComponentMetadata, ComponentProp, Entity } from "./types.js";

/**
 * Loads component metadata from each component directory's `component.json`.
 * The server stays read-only: component code is authored in the source repo,
 * while this metadata gives agents stable imports, props, constraints, and examples.
 */
export async function loadComponents(repoPath: string, logger: Logger): Promise<Entity[]> {
  const dir = path.join(repoPath, "components");
  if (!(await dirExists(dir))) {
    logger.debug({ dir }, "no components/ directory");
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      componentDir: path.join(dir, e.name),
      file: path.join(dir, e.name, "component.json"),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const entities: Entity[] = [];
  for (const { componentDir, file } of files) {
    if (!(await fileExists(file))) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      logger.warn(
        { file: path.relative(repoPath, file), err: (err as Error).message },
        "component: invalid JSON, skipping",
      );
      continue;
    }

    const result = ComponentMetadataSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(
        { file: path.relative(repoPath, file), errors: result.error.format() },
        "component: schema validation failed, skipping",
      );
      continue;
    }

    const component = await enrichComponentMetadata(
      componentDir,
      result.data as ComponentMetadata,
      logger,
    );
    entities.push({
      id: component.id,
      type: "component",
      summary: component.summary,
      tags: ["component", ...component.tags],
      data: component as unknown as Record<string, unknown>,
      related: [
        ...component.related,
        ...component.tokens,
        ...component.principles,
        ...component.patterns,
      ],
      source: { path: path.relative(repoPath, file) },
    });
  }

  logger.info({ count: entities.length }, "loaded component entities");
  return entities;
}

async function enrichComponentMetadata(
  componentDir: string,
  component: ComponentMetadata,
  logger: Logger,
): Promise<ComponentMetadata> {
  const apiProps = await loadComponentApiProps(componentDir, component.name, logger);
  if (apiProps.length === 0) return component;

  return {
    ...component,
    props: mergeProps(component.props, apiProps),
  };
}

function mergeProps(metadataProps: ComponentProp[], apiProps: ComponentProp[]): ComponentProp[] {
  const merged = [...metadataProps];
  const byName = new Map(metadataProps.map((prop) => [prop.name, prop]));
  for (const apiProp of apiProps) {
    if (byName.has(apiProp.name)) continue;
    merged.push(apiProp);
  }
  return merged;
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
