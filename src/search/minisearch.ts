import MiniSearch from "minisearch";
import type { Entity, IndexedDoc, SchemaDefinition } from "../bundle/types.js";

const DEFAULT_FIELDS = ["summary", "tags", "name", "title", "body", "$type"] as const;

export function buildSearchIndex(
  entities: ReadonlyMap<string, Entity>,
  schema: SchemaDefinition,
): MiniSearch<IndexedDoc> {
  const fieldsSet = new Set<string>(DEFAULT_FIELDS);
  for (const def of Object.values(schema.types)) {
    for (const f of def.searchable) fieldsSet.add(f);
  }
  const fields = [...fieldsSet];

  const ms = new MiniSearch<IndexedDoc>({
    fields,
    storeFields: ["id", "type", "summary", "tags"],
    searchOptions: {
      boost: { name: 3, title: 2, summary: 2, tags: 1.5 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: "OR",
    },
  });

  const docs: IndexedDoc[] = [];
  for (const ent of entities.values()) {
    const data = ent.data ?? {};
    docs.push({
      id: ent.id,
      type: ent.type,
      summary: ent.summary,
      tags: ent.tags.join(" "),
      name: pickString(data, "name"),
      title: pickString(data, "title"),
      body: pickString(data, "body") ?? componentSearchBody(data),
      $type: pickString(data, "$type"),
    });
  }
  ms.addAll(docs);
  return ms;
}

function pickString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

function componentSearchBody(data: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];
  const props = data.props;
  if (Array.isArray(props)) {
    for (const p of props) {
      if (typeof p !== "object" || p === null) continue;
      const rec = p as Record<string, unknown>;
      chunks.push(String(rec.name ?? ""), String(rec.description ?? ""), String(rec.type ?? ""));
      const values = rec.values;
      if (Array.isArray(values)) chunks.push(values.join(" "));
    }
  }
  const constraints = data.constraints;
  if (Array.isArray(constraints)) {
    for (const c of constraints) {
      if (typeof c !== "object" || c === null) continue;
      chunks.push(String((c as Record<string, unknown>).message ?? ""));
    }
  }
  return chunks.filter(Boolean).join(" ") || undefined;
}
