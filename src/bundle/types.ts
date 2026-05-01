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
  readonly #keys = new Set<string>();

  add(rel: Relation): void {
    const key = `${rel.from}\0${rel.type}\0${rel.to}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
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

export interface UsageExample {
  name: string;
  language: string;
  code: string;
  description?: string | undefined;
}

export interface ComponentDependency {
  package: string;
  version?: string | undefined;
  type: "runtime" | "peer" | "dev";
  reason?: string | undefined;
}

export interface ImportGuidance {
  named: string[];
  default?: string | undefined;
  namespace?: string | undefined;
  sideEffects: string[];
  notes: string[];
}

export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
  description?: string | undefined;
  values?: string[] | undefined;
  default?: string | number | boolean | undefined;
}

export interface DesignConstraint {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
  rationale?: string | undefined;
}

export interface ComponentMetadata {
  id: string;
  type: "component";
  name: string;
  summary: string;
  package?: string | undefined;
  importPath: string;
  dependencies: ComponentDependency[];
  importGuidance?: ImportGuidance | undefined;
  status: "stable" | "experimental" | "deprecated";
  tags: string[];
  props: ComponentProp[];
  examples: UsageExample[];
  constraints: DesignConstraint[];
  tokens: string[];
  principles: string[];
  patterns: string[];
  related: string[];
}

export interface PatternContractSlot {
  name: string;
  required: boolean;
  component?: string | undefined;
  description?: string | undefined;
}

export interface PatternContract {
  requiredComponents: string[];
  optionalComponents: string[];
  forbiddenComponents: string[];
  requiredTokens: string[];
  requiredPrinciples: string[];
  slots: PatternContractSlot[];
  constraints: DesignConstraint[];
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
  /**
   * Path of the rule definition file relative to the source repo root, e.g.
   * "rules/no-hex-colors.json". `undefined` for built-in rules shipped with
   * the server. Populated by the rule loader.
   */
  sourcePath?: string | undefined;
}

/**
 * Provenance for a violation: where the rule itself came from, and which
 * design-system entity (if any) the violation links back to. Populated by
 * the validator that produced the violation. Optional because not every
 * rule has a meaningful entity to point at.
 */
export interface ViolationProvenance {
  ruleSource: "built-in" | "source-repo";
  /** Path of the rule definition file in the source repo, when applicable. */
  rulePath?: string | undefined;
  /** Entity id that motivates the rule or supplies the suggested fix. */
  sourceEntity?: string | undefined;
  /** Source path of that entity within the design-system repo. */
  sourceEntityPath?: string | undefined;
}

export interface Violation {
  ruleId: string;
  severity: RuleSeverity;
  message: string;
  line?: number | undefined;
  column?: number | undefined;
  match?: string | undefined;
  /** Free-text human-facing remediation hint. */
  suggestion?: string | undefined;
  /**
   * Deterministic, machine-applicable replacement. Present only when the rule
   * can produce a single correct fix — e.g. "remove this attribute", or
   * "replace this CSS variable with this exact other CSS variable". When set,
   * IDE consumers may apply the substitution at `(line, column, match.length)`.
   */
  replaceWith?: string | undefined;
  /** Where the rule + linked entity come from. See ViolationProvenance. */
  provenance?: ViolationProvenance | undefined;
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
