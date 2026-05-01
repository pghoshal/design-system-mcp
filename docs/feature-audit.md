# Advanced features audit

> Maps the 24 advanced features previously listed by Codex against the actual code in this repo (as of 2026-05-02). Each entry cites file paths so the answer is verifiable, not vibes.

Legend: ✅ implemented · 🟡 partial · ❌ missing

---

## 1. Component API Parser — ✅ implemented

`src/bundle/component-api.ts` (225 LOC) loads `typescript` dynamically and walks AST of `*.{ts,tsx,js,jsx}` files in each component dir to extract:

- ✅ prop names (`PropertySignature.name`)
- ✅ prop types as text (`member.type.getText()`)
- ✅ required vs optional (`questionToken === undefined` → required)
- ✅ JSDoc descriptions (`getJSDocCommentsAndTags`)
- ✅ string-union variant values (`unionStringValues`)
- ✅ default values from `@default` JSDoc
- ✅ deprecated-prop tagging from `@deprecated` JSDoc
- ✅ replacement hints from `@deprecated Use <prop> instead`
- ✅ controlled-state hints for common controlled prop names
- ❌ component exports / package paths (those come from `component.json`, not the parser)

**Status:** real AST parsing exists for props, variants, JSDoc descriptions/defaults/deprecation, and controlled-state hints. Package paths remain intentionally sourced from `component.json`.

---

## 2. Storybook Parser — ✅ implemented

`src/bundle/storybook.ts` (223 LOC) walks `*.stories.{ts,tsx,js,jsx}` AST.

- ✅ canonical examples (each `export const X = { ... }` → one `UsageExample`)
- ✅ args extraction
- ✅ variants from story names
- ✅ states from story names
- ✅ controls from literal `argTypes.options`
- ✅ interaction examples (`play` functions stored as interaction notes)
- ❌ visual edge cases (no screenshot or visual-regression hooks)

**Status:** CSF parsing covers examples, args, states, controls, and interaction notes without executing Storybook. Screenshot/visual-regression hooks remain out of scope for this server.

---

## 3. MDX Documentation Parser — ✅ implemented

`src/bundle/markdown.ts` handles `.md` and `.mdx`. MDX-specific behavior:

- ✅ strips imports / exports / component-only JSX from indexed body so search isn't polluted
- ✅ keeps frontmatter + prose searchable
- ✅ extracts machine-readable frontmatter `tokens:` blocks (DTCG-normalized) — see `src/bundle/tokens.ts:99-135` (`extractMarkdownTokenSources`)
- ✅ extracts MDX `<DoDont doText="..." dontText="..." />` into `entity.data.structured.do` / `dont`
- ✅ extracts Markdown `## Do` / `## Do not` lists
- ✅ extracts `## Accessibility` notes
- ✅ extracts `## Migration` notes
- ✅ extracts `## Props` Markdown tables into normalized prop rows

**Status:** body-text indexing is solid, including MDX, and common UX-to-dev handoff structures are promoted into machine-readable entity data.

---

## 4. Accessibility Rule Engine — ✅ implemented (deterministic, narrow)

`src/validation/accessibility.ts`. Built-in rule IDs (`ACCESSIBILITY_RULE_IDS`):

```
a11y-img-alt
a11y-button-name
a11y-link-name
a11y-form-control-label
a11y-no-positive-tabindex
a11y-no-autofocus
a11y-valid-aria-role
```

- ✅ missing accessible labels (img alt, button/link name, form-control label)
- ✅ positive tabindex
- ✅ autoFocus
- ✅ invalid ARIA roles
- ❌ dialog focus / escape requirements
- ❌ color-contrast token requirements
- ❌ keyboard interaction requirements

**Status:** deterministic rules cover common WCAG quick wins plus ARIA role validity. Dialog focus, contrast, and keyboard interaction rules remain future deeper checks.

---

## 5. Semantic Token Validator — ✅ implemented (4 rules)

`src/validation/tokens.ts` (232 LOC). Built-in rule IDs (`SEMANTIC_TOKEN_RULE_IDS`):

```
no-raw-length-values
no-raw-color-functions
no-unknown-css-vars
prefer-semantic-tokens
no-deprecated-tokens
```

- ✅ raw px / rem / em / etc.
- ✅ raw `rgb()`, `rgba()`, `hsl()`, color literals
- ✅ unknown CSS custom-property references
- ✅ "prefer semantic over primitive" warning when a primitive token (`--color-blue-500`) is used in app code
- ✅ deprecated-token flagging with replacement suggestions
- ❌ category enforcement (e.g., spacing token used as color)
- ❌ allowed-tokens-per-component-variant

**Status:** core "no raw values, prefer semantic, no deprecated aliases" coverage is in. Per-component allowlists and category enforcement are not.

---

## 6. Composition Validator v2 — 🟡 partial

`src/tools/validate-composition.ts` (237 LOC) enforces against pattern `data.contract`:

- ✅ required components
- ✅ forbidden components
- ✅ required tokens (component must declare them in its metadata)
- ✅ required principles
- ✅ slots (each named slot must be filled by the right component)
- ❌ allowed parent/child relationships
- ❌ required ordering / layout
- ❌ state combinations
- ❌ platform/framework-specific constraints
- ❌ free-form `constraints` are loaded from contract but only surfaced as guidance, not enforced (see comment in source: `Free-form contract constraints are guidance unless/until they have a [machine-checkable detector]`)

**Status:** structural composition (presence/absence/slots) works. Behavioral, ordering, and platform-conditional constraints don't.

---

## 7. Pattern Contract Schema — ✅ implemented

`src/bundle/schema.ts` `PatternContractSchema`:

```ts
requiredComponents
optionalComponents
forbiddenComponents
requiredTokens
requiredPrinciples
slots: Array<{ name, required, component?, description? }>
constraints: Array<DesignConstraint{ id, severity, message, rationale? }>
```

- ✅ required / optional / forbidden components
- ✅ required tokens
- ✅ required slots
- ❌ interaction rules (no schema field)
- ❌ copy rules (handled separately by `validate_ui` copy detector, not the contract)
- ❌ accessibility rules (same — separate detector)
- ❌ examples / anti-examples (no fields for either)

**Status:** structural contract schema is in. No interaction/copy/a11y/example fields yet.

---

## 8. Design Brief / Harness Contract — ✅ implemented (server-side contract)

The intended workflow is **described** by `recommend_composition`'s `nextSteps` output (`src/tools/recommend-composition.ts`):

```
Call get_usage for selected components before writing code.
Call resolve_token for every token value needed in code.
Call validate_composition on the planned components and props.
Call validate_ui on generated code and repair all error violations.
```

- ✅ tools exist that map to the steps (`describe_schema`, `recommend_composition`, `get_usage`, `resolve_token`, `validate_composition`, `validate_ui`)
- ✅ `nextSteps` is a deterministic, machine-readable order
- ✅ `design://workflow` packages the sequence, final gate, and CI commands as a machine-readable resource
- 🟡 no enforced harness inside the MCP server (the agent can skip steps; client/CI must block final output)
- ❌ no MCP prompt named e.g. `harness_workflow` that codifies the loop
- ❌ no "repair until clean" loop tool

**Status:** the server now publishes a deterministic workflow contract. Hard enforcement remains a client/CI responsibility (#24).

---

## 9. MCP Resources — ✅ implemented (with one URI scoped out)

`src/server/registrations.ts` registers:

```
design://manifest                static
design://schema                  static
design://entity/{id}             template
design://principle/{id}          template (per-type filter)
design://pattern/{id}            template (per-type filter)
design://component/{id}          template (per-type filter)
design://prompt/{name}           template
```

- ✅ design://manifest, design://schema, design://entity/{id}, design://component/{id}, design://pattern/{id}
- ❌ design://tokens/{category} — explicitly excluded; tokens have a free-form dotted-path namespace (no stable categories). Use `design://entity/token:<dot.path>` or `resolve_token`. Documented in `.claude/flows.md` §3.
- ❌ design://rules — not a resource yet
- ✅ design://workflow — handoff/harness contract from #8

**Status:** all entity types and the workflow contract are exposed. `design://rules` remains a possible future resource.

---

## 10. MCP Prompts — ✅ implemented

`src/server/registrations.ts` `registerPrompts()` registers every prompt loaded from the source repo's `prompts/*.prompt.md`. The fixture ships a starter set:

- ✅ wiring is done (any prompt added by UX shows up in `prompts/list` automatically)
- ✅ `build_with_design_system`
- ✅ `review_ui_against_design_system`
- ✅ `repair_design_violations`
- ✅ `choose_component`
- ✅ `migrate_to_design_system`

**Status:** infrastructure is complete and the fixture demonstrates the expected starter prompt set. Real production prompt wording remains source-repo owned.

---

## 11. Similarity / Alternatives — ✅ implemented

`src/tools/recommend-composition.ts` returns up to N components ranked by MiniSearch BM25 score, plus constraints, explicit alternatives, and recommendation provenance.

- ✅ ranking by intent + platform + framework (concatenated into the search query)
- ✅ explicit alternatives by type
- ✅ alternatives are ranked by status and stable id ordering
- ✅ recommendation provenance explains search matches and relation expansion
- ✅ `explain_decision` gives deterministic source/relation/constraint evidence for a selected entity
- ❌ deprecated → replacement suggestion in this tool (the schema supports `status: deprecated` per component but no automatic replacement path)

**Status:** intent-driven ranking, alternatives, and deterministic explanations are implemented. Deprecation replacement paths remain outside this feature.

---

## 12. Deterministic Decision Explanations — ✅ implemented

`src/tools/explain-decision.ts` adds `explain_decision`, and `recommend_composition` now includes provenance for recommended entities.

- ✅ source-path evidence
- ✅ relation evidence
- ✅ constraint evidence
- ✅ intent term overlap evidence
- ✅ validation violations carry provenance for source-repo and built-in rules

**Status:** implemented as a first-class generic verb plus recommendation/violation provenance.

---

## 13. Violation Repair Suggestions — ✅ implemented

`Violation` type (`src/bundle/types.ts`) has optional `suggestion?: string`, `replaceWith?: string`, `repair?: ViolationRepair`, and `provenance?: ViolationProvenance` fields. `validate_ui` exposes those fields in its public output schema (`src/tools/validate-ui.ts`).

- ✅ accessibility rules (`src/validation/accessibility.ts`)
- ✅ copy rules (`src/validation/copy.ts`)
- ✅ token rules include deterministic repair for deprecated token aliases when the replacement token resolves
- ✅ source-repo regex rules now carry provenance (`rulePath`) through `src/validation/regex.ts`
- ✅ deterministic `replaceWith` exists where a single correct edit is known, e.g. removing `autoFocus` or replacing a deprecated token CSS var
- ✅ deterministic before/after `repair` snippets are attached centrally for every violation with `replaceWith`
- ✅ CI JSON and SARIF include repair metadata when available

Deliberate boundary:

- ✅ machine-readable replacement is present only when there is exactly one safe edit
- ✅ rules that require design/product judgment return `suggestion` but no auto-fix
- ✅ source-entity references exist when a natural source entity exists

**Status:** structured repair payloads are first-class and deterministic. Non-deterministic findings intentionally remain suggestions only.

---

## 14. Copy / Voice Validator — ✅ implemented (4 rules)

`src/validation/copy.ts` (206 LOC). Built-in rule IDs (`COPY_RULE_IDS`):

```
copy-no-blame
copy-no-hype
copy-no-vague-actions
copy-no-destructive-hedging
```

- ✅ banned phrases (blame language: "you forgot", "you haven't")
- ✅ hype / exclamation marks
- ✅ vague action labels (Submit, Process, OK)
- ✅ destructive hedging (no "maybe", "might" on destructive actions)
- ❌ preferred terminology dictionary
- ❌ empty/error/success tone differentiation
- ❌ reading-level constraints
- ❌ product-vocabulary glossary

**Status:** core "voice and tone" guardrails for the most common slop patterns. No glossary / reading-level / per-surface tone rules.

---

## 15. Design Decision Trace — ✅ implemented

The repo now has provenance on both validation and recommendation surfaces:

- ✅ source-repo regex rules include `rulePath`
- ✅ built-in rules identify `ruleSource: "built-in"`
- ✅ primitive token warnings link to the token entity + source path
- ✅ copy/voice violations link to the loaded voice entity + source path
- ✅ `recommend_composition` includes recommendation provenance with source path, reasons, and relation path
- ✅ `explain_decision` exposes source, relation, match, and constraint evidence

**Status:** implemented for validation and recommendation decisions. Composition-specific violation provenance can still deepen later.

---

## 16. Component Dependency / Import Guidance — ✅ implemented

`src/bundle/schema.ts`:

```ts
ComponentDependencySchema:  package, version?, type: "runtime"|"peer"|"dev", reason?
ImportGuidanceSchema:       named, default?, namespace?, sideEffects, notes
```

`src/tools/get-usage.ts` returns these as part of the tool output.

- ✅ package name
- ✅ import path (string literal)
- ✅ peer / runtime / dev dependency classification
- ✅ side-effects guidance
- ✅ free-text notes (e.g., "wrap in <ThemeProvider>")
- ❌ explicit `requiredWrappers` / `requiredProviders` field (currently fits in `notes`)
- ❌ framework version constraint enforcement (only documented, not validated)

**Status:** mostly there. Provider / wrapper requirements are notes-as-text, not structured.

---

## 17. Deprecation and Migration — 🟡 partial, improved

The schema supports `status: "stable" | "experimental" | "deprecated"` on component metadata (`src/bundle/schema.ts`). Beyond that:

- ✅ deprecated components flagged
- ✅ deprecated **props** — `ComponentPropSchema` carries `deprecated` / `replacedBy`
- ✅ `validate_composition` warns on deprecated prop usage and suggests replacements
- ✅ deprecated **tokens** — token entities preserve `$deprecated` / `$replacement`
- ✅ `validate_ui` blocks deprecated token CSS vars and suggests replacements
- 🟡 replacement IDs exist for props/tokens, not component-level chains
- ❌ migration examples (no schema for them)
- ❌ hard errors for forbidden legacy usage (no rule enforces "do not import deprecated components")

**Status:** component, prop, and token deprecation are modeled enough for validation. Component-level replacement chains and migration examples remain open.

---

## 18. CI / PR Validation Mode — ✅ implemented

There is now a CLI path for invoking `validate_ui` outside MCP:

- ✅ `pnpm validate` script in `package.json`
- ✅ `src/validate-cli.ts` reads file(s), loads a local design-system source, invokes `validate_ui`, prints JSON, and exits `1` on error violations
- ✅ integration coverage in `tests/integration/validate-cli.test.ts`
- ✅ SARIF output mode for GitHub code-scanning integrations
- ✅ `validate_composition` batch mode via `--composition <plan.json>`

**Status:** JSON/SARIF UI validation and JSON/SARIF composition-plan validation are implemented for CI.

---

## 19. Bundle Quality Checks — 🟡 partial

`src/tools/inspect-coverage.ts` (175 LOC) reports issues at refresh time:

- ✅ schema completeness (`required-type-missing-from-schema`, `declared-type-empty`)
- ✅ missing related entity (`relation-target-missing`)
- ✅ duplicate entity ids (handled at build time in `src/bundle/builder.ts:43-49` with `duplicates` warning)
- ✅ component-side gaps (`component-import-missing`, `component-dependencies-empty`, `component-props-empty`, `component-examples-empty`, `component-principles-empty`)
- ✅ orphan components (`component-orphan`)
- ✅ missing pattern contracts (`pattern-contract-missing`)
- ✅ missing pattern-contract targets (`pattern-contract-target-missing`)
- 🟡 invalid token references — Style Dictionary throws on broken refs (`brokenReferences: "throw"` in `src/bundle/tokens.ts:42`); not surfaced through `inspect_coverage` separately
- ❌ examples-compile sanity (no parser / type-checker on example code blocks)
- 🟡 orphan patterns beyond missing contracts are not separately ranked
- ❌ stale deprecated-replacement targets (deprecation isn't deeply modeled — see #17)

**Status:** structural and metadata-completeness coverage is good. Deeper checks (compile, orphans, stale replacements) are not.

---

## 20. Framework Adapters — 🟡 partial

`RuleLanguageSchema` (`src/bundle/schema.ts`):

```
"tsx" | "jsx" | "ts" | "js" | "css" | "html" | "vue"
```

- ✅ React / TSX / JSX (validation rules apply)
- ✅ TS / JS (token rules)
- ✅ CSS (semantic-token rules)
- ✅ HTML (a11y, copy)
- ✅ Vue (advertised in the enum; same regex paths apply)
- ❌ React Native — not in the enum
- ❌ no framework-aware AST adapter — see #21 below

**Status:** language flag exists; per-framework AST validation is the gap, not the language list.

---

## 21. AST-Based Validation — ✅ implemented

The codebase now has a first source-repo AST detector for runtime validation rules.

The `RuleDetector` union type (`src/bundle/types.ts`) is now:

```ts
export type RuleDetector = RegexDetector | JsxPropValueDetector;
```

`JsxPropValueDetector` supports literal JSX prop allow/disallow checks, e.g. banning `<Button variant="ghost">` without brittle regex matching.

- ✅ AST is used for component metadata extraction (`src/bundle/component-api.ts`, `src/bundle/storybook.ts`)
- ✅ AST is used for source-repo validation rules through `src/validation/ast.ts`
- ✅ JSX-prop-value rule kind
- ❌ no className/token-usage AST rule
- ❌ no plugin escape hatch

**Status:** implemented for JSX prop literal validation. Deeper className/token AST rules and plugin escape hatches remain future depth.

---

## 22. Design-System Coverage Report — 🟡 partial

The `inspect_coverage` tool answers part of this:

- ✅ which components lack examples / constraints / principles / props / dependencies
- ✅ which schema types are declared but empty
- ✅ which entities reference missing relation targets
- ❌ which tokens are unused (no token-usage scan)
- ✅ which patterns lack validation contracts (`pattern-contract-missing`)
- ✅ orphan components (`component-orphan`)
- 🟡 broader relation-graph orphan reporting remains shallow
- ❌ which schemas are incomplete in deeper senses (e.g., a component declares a prop that no example uses)

**Status:** the existing tool is the closest analogue to a coverage report; deeper graph checks are not.

---

## 23. Strict Schema Specs — 🟡 partial

What IS strictly schema'd (`src/bundle/schema.ts`):

- ✅ component metadata (`ComponentMetadataSchema`)
- ✅ pattern contract (`PatternContractSchema`)
- ✅ usage example (`UsageExampleSchema`)
- ✅ design constraint (`DesignConstraintSchema`)
- ✅ rule (`RuleSchema`) + regex detector (`RegexDetectorSchema`)
- ✅ frontmatter (`FrontmatterSchema`, `PromptFrontmatterSchema`)
- ✅ component dependency / import guidance / prop / pattern slot

What is NOT yet schema'd:

- ❌ token entity (loaded freely from DTCG; no first-party Zod for the resulting Entity.data shape)
- ❌ accessibility-contract (no separate schema; rules embed in the rule schema)
- ❌ copy-rule (same — no separate schema)
- ❌ migration (no field beyond a single `status` enum)
- ❌ platform mapping (no schema for "this component on iOS uses X")

**Status:** strong on component / pattern / usage / constraint / rule. Weak on token / migration / platform-mapping schemas.

---

## 24. Harness-Enforced Modes — 🟡 partial (server-published, client-enforced)

The server publishes a machine-readable workflow contract at `design://workflow`, but it has no mode flag, state machine, or "agent must validate before final output" enforcement.

The `recommend_composition` `nextSteps` output is **advisory** — the agent can ignore it. Nothing in this server forces:

- ❌ `plan_only` mode
- ❌ `generate` mode
- ❌ `validate` mode
- ❌ `repair` mode
- ❌ `final_check` gate that blocks output until all error-severity violations are resolved

This is a harness-side feature (the client / IDE / agent loop), not really a server-side feature. The MCP server now publishes the workflow resource (#8), but it cannot enforce that an agent runs it.

**Status:** server-side contract is implemented; blocking enforcement needs a client-side or harness-side layer.

---

# Summary

| # | Feature | Status |
|---|---|---|
| 1 | Component API parser | ✅ props + variants + defaults + @deprecated + controlled hints |
| 2 | Storybook parser | ✅ examples + args + controls + play notes + states |
| 3 | MDX documentation parser | ✅ search-clean body + structured do/don't / accessibility / migration / props |
| 4 | Accessibility rule engine | ✅ 7 rules (ARIA roles included; no dialog focus / contrast) |
| 5 | Semantic token validator | ✅ 5 rules (deprecated tokens included; no category enforcement / per-component allowlists) |
| 6 | Composition validator v2 | 🟡 partial (structural; no ordering / state / platform) |
| 7 | Pattern contract schema | ✅ structural shape (no interaction / copy / a11y fields) |
| 8 | Design brief / harness contract | ✅ `nextSteps` plus `design://workflow`; enforcement is harness-side |
| 9 | MCP resources | ✅ all entity types + per-type templates + `design://workflow` |
| 10 | MCP prompts | ✅ wiring complete + starter prompt set |
| 11 | Similarity / alternatives | ✅ explicit alternatives + provenance |
| 12 | Deterministic decision explanations | ✅ `explain_decision` tool |
| 13 | Violation repair suggestions | ✅ deterministic replaceWith + before/after repair payloads |
| 14 | Copy / voice validator | ✅ 4 rules (no glossary / reading-level / per-surface tone) |
| 15 | Design decision trace | ✅ validation + recommendation provenance |
| 16 | Component dependency / import guidance | ✅ schema'd; surfaced via `get_usage` |
| 17 | Deprecation and migration | 🟡 component + prop + token deprecation; no component replacement chains |
| 18 | CI / PR validation mode | ✅ JSON/SARIF validate_ui + composition batch CLI |
| 19 | Bundle quality checks | 🟡 structural + metadata + orphan/contract coverage; no example compile / stale replacement |
| 20 | Framework adapters | 🟡 language flag covers tsx/jsx/ts/js/css/html/vue (no React Native; no per-framework AST) |
| 21 | AST-based validation rules | ✅ JSX prop value detector; className/token AST rules remain future depth |
| 22 | Design-system coverage report | 🟡 component-side + orphan + missing-contract coverage; token-usage still shallow |
| 23 | Strict schema specs | 🟡 strong for component / pattern / rule; weak for token / migration / platform |
| 24 | Harness-enforced modes | 🟡 `design://workflow` published; hard blocking remains client-side |

**Tally:** 17 ✅ · 7 🟡 · 0 ❌ (out of 24).

The remaining major-gap set has no fully missing server-side item. The hard parts left are depth expansions:

- **Harness hard enforcement** (24) — server-side workflow resource exists; the blocking loop belongs in the client/CI harness.
- **Deeper AST adapters** (21 follow-up depth) — className/token usage and plugin escape hatch are still future work.

The remaining partials are mostly "the surface exists but the depth doesn't" — rules can be added (each is ~20-40 LOC), schema fields can be extended.

For each item that's worth promoting from 🟡 to ✅, the cheapest path is:

| Promote | Approach |
|---|---|
| #4 Accessibility → dialog / contrast | Add dialog focus/escape and token-based contrast rules to `accessibility.ts` |
| #5 Tokens → category enforcement | Add a rule keyed off the token's `$type` field |
| #7 Pattern contract → +copy + interaction | Extend `PatternContractSchema` with `copyRules: string[]`, `interactionRules: string[]` |
| #17 Deprecation → component replacement | Add replacement fields to component schemas and migration examples |
| #22 Coverage → token-usage | Add unused-token and deprecated-token target checks in `inspect-coverage.ts` |

If you want any of these landed, the cheapest 5 in priority order would be:

1. **#5 Semantic token category enforcement** — detect color tokens in spacing/layout slots and spacing tokens in color slots.
2. **#6 Composition ordering/state/platform constraints** — add machine-checkable contract fields before enforcing them.
3. **#17 Deprecation and migration** — add component-level replacement chains and migration examples.

Each is a discrete slice that fits a TDD-RED→GREEN→Critic cycle.
