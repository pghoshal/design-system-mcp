import type MiniSearch from "minisearch";

export interface Entity {
  id: string;
  type: string;
  summary: string;
  tags: string[];
  data: Record<string, unknown>;
  related?: string[] | undefined;
  source: { path: string; line?: number | undefined };
}

export interface EntitySummary {
  id: string;
  type: string;
  summary: string;
  tags: string[];
}

export interface TypeDef {
  description?: string | undefined;
  searchable: string[];
  facets?: string[] | undefined;
  idPattern?: string | undefined;
}

export interface RelationDef {
  from: string;
  to: string;
  description?: string | undefined;
}

export interface SchemaDefinition {
  types: Record<string, TypeDef>;
  relations: Record<string, RelationDef>;
}

export interface Relation {
  from: string;
  to: string;
  type: string;
}

export class RelationsIndex {
  readonly #out = new Map<string, Relation[]>();
  readonly #in = new Map<string, Relation[]>();

  add(rel: Relation): void {
    this.#getOrInit(this.#out, rel.from).push(rel);
    this.#getOrInit(this.#in, rel.to).push(rel);
  }

  outFor(id: string): readonly Relation[] {
    return this.#out.get(id) ?? [];
  }

  inFor(id: string): readonly Relation[] {
    return this.#in.get(id) ?? [];
  }

  #getOrInit(m: Map<string, Relation[]>, k: string): Relation[] {
    let v = m.get(k);
    if (!v) {
      v = [];
      m.set(k, v);
    }
    return v;
  }
}

export interface PromptTemplate {
  name: string;
  description?: string | undefined;
  arguments: Array<{ name: string; required: boolean; description?: string | undefined }>;
  body: string;
}

export type RuleSeverity = "error" | "warning" | "info";
export type RuleLanguage = "tsx" | "jsx" | "ts" | "js" | "css" | "html" | "vue";

export interface RegexDetector {
  type: "regex";
  pattern: string;
  flags?: string | undefined;
  message: string;
}

export type RuleDetector = RegexDetector;

export interface Rule {
  id: string;
  description: string;
  severity: RuleSeverity;
  appliesTo: RuleLanguage[];
  detector: RuleDetector;
}

export interface Violation {
  ruleId: string;
  severity: RuleSeverity;
  message: string;
  line?: number | undefined;
  column?: number | undefined;
  match?: string | undefined;
}

/**
 * Indexed document used by MiniSearch. Mirrors Entity but flattens fields so
 * BM25 can score over them. We keep the full Entity in `entities` for retrieval.
 */
export interface IndexedDoc {
  id: string;
  type: string;
  summary: string;
  tags: string;
  name?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  $type?: string | undefined;
}

export interface Bundle {
  version: string;
  schemaVersion: string;
  builtAt: string;
  gitSha?: string | undefined;
  sourcePath: string;
  entities: ReadonlyMap<string, Entity>;
  schema: SchemaDefinition;
  relations: RelationsIndex;
  searchIndex: MiniSearch<IndexedDoc>;
  tokensResolved: Record<string, unknown>;
  prompts: PromptTemplate[];
  rules: Rule[];
}
