import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../observability/logger.js";
import { DEFAULT_SCHEMA, ManifestSchema } from "./schema.js";
import type { SchemaDefinition } from "./types.js";

export interface ManifestLoadResult {
  schemaVersion: string;
  schema: SchemaDefinition;
  source: "manifest.json" | "default";
}

export async function loadManifest(repoPath: string, logger: Logger): Promise<ManifestLoadResult> {
  const manifestPath = path.join(repoPath, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info({ manifestPath }, "no manifest.json; using DEFAULT_SCHEMA");
      return { schemaVersion: "1.0.0", schema: DEFAULT_SCHEMA, source: "default" };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `manifest.json failed schema validation:\n${JSON.stringify(result.error.format(), null, 2)}`,
    );
  }

  return {
    schemaVersion: result.data.schemaVersion,
    schema: result.data.schema,
    source: "manifest.json",
  };
}
