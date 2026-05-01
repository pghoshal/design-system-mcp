# Advanced features audit

> Maps the 24 advanced features previously listed by Codex against the actual code in this repo (as of 2026-05-02). Each entry cites file paths so the answer is verifiable, not vibes.

Legend: ✅ implemented · 🟡 partial · ❌ missing

---

## 1. Component API Parser — 🟡 partial

`src/bundle/component-api.ts` (225 LOC) loads `typescript` dynamically and walks AST of `*.{ts,tsx,js,jsx}` files in each component dir to extract:

- ✅ prop names (`PropertySignature.name`)
- ✅ prop types as text (`member.type.getText()`)
- ✅ required vs optional (`questionToken === undefined` → required)
- ✅ JSDoc descriptions (`getJSDocCommentsAndTags`)
- ✅ string-union variant values (`unionStringValues`)
- ❌ default values
- ❌ deprecated-prop tagging (no `@deprecated` JSDoc handling)
- ❌ controlled vs uncontrolled detection
- ❌ component exports / package paths (those come from `component.json`, not the parser)

**Status:** real AST parsing exists for props + variants. Defaults, deprecation, controlled-vs-uncontrolled are not parsed.

---

## 2. Storybook Parser — 🟡 partial

`src/bundle/storybook.ts` (223 LOC) walks `*.stories.{ts,tsx,js,jsx}` AST.

- ✅ canonical examples (each `export const X = { ... }` → one `UsageExample`)
- ✅ args extraction
- ✅ variants from story names
- ❌ states (no per-state extraction)
- ❌ controls / `argTypes` (only flat args)
- ❌ interaction examples (`play` functions not parsed)
- ❌ visual edge cases (no screenshot or visual-regression hooks)

**Status:** baseline CSF parsing for examples. Doesn't yet harvest controls or interaction tests.

---

## 3. MDX Documentation Parser — 🟡 partial

`src/bundle/markdown.ts` (314 LOC) handles `.md` and `.mdx`. MDX-specific behavior:

- ✅ strips imports / exports / component-only JSX from indexed body so search isn't polluted
- ✅ keeps frontmatter + prose searchable
- ✅ extracts machine-readable frontmatter `tokens:` blocks (DTCG-normalized) — see `src/bundle/tokens.ts:99-135` (`extractMarkdownTokenSources`)
- ❌ structured do/don't extraction
- ❌ structured prop tables (only prose)
- ❌ structured accessibility notes
- ❌ structured migration sections

**Status:** body-text indexing is solid, including MDX. No structured extraction of `<DoDont>`, `<PropTable>`, etc.

---

## 4. Accessibility Rule Engine — ✅ implemented (deterministic, narrow)

`src/validation/accessibility.ts` (286 LOC). Built-in rule IDs (`ACCESSIBILITY_RULE_IDS`):

```
a11y-img-alt
a11y-button-name
a11y-link-name
a11y-form-control-label
a11y-no-positive-tabindex
a11y-no-autofocus
```

- ✅ missing accessible labels (img alt, button/link name, form-control label)
- ✅ positive tabindex
- ✅ autoFocus
- ❌ invalid ARIA roles
- ❌ dialog focus / escape requirements
- ❌ color-contrast token requirements
- ❌ keyboard interaction requirements

**Status:** 6 rules covering the most common WCAG-quick-wins. No ARIA-role taxonomy, no contrast checker, no dialog-focus rule.

---

## 5. Semantic Token Validator — ✅ implemented (4 rules)

`src/validation/tokens.ts` (232 LOC). Built-in rule IDs (`SEMANTIC_TOKEN_RULE_IDS`):

```
no-raw-length-values
no-raw-color-functions
no-unknown-css-vars
prefer-semantic-tokens
```

- ✅ raw px / rem / em / etc.
- ✅ raw `rgb()`, `rgba()`, `hsl()`, color literals
- ✅ unknown CSS custom-property references
- ✅ "prefer semantic over primitive" warning when a primitive token (`--color-blue-500`) is used in app code
- ❌ category enforcement (e.g., spacing token used as color)
- ❌ allowed-tokens-per-component-variant
- ❌ deprecated-token flagging with replacement suggestions

**Status:** core "no raw values, prefer semantic" coverage is in. Per-component allowlists and deprecation chains are not.

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

## 8. Design Brief / Harness Contract — 🟡 partial

The intended workflow is **described** by `recommend_composition`'s `nextSteps` output (`src/tools/recommend-composition.ts`):

```
Call get_usage for selected components before writing code.
Call resolve_token for every token value needed in code.
Call validate_composition on the planned components and props.
Call validate_ui on generated code and repair all error violations.
```

- ✅ tools exist that map to the steps (`describe_schema`, `recommend_composition`, `get_usage`, `resolve_token`, `validate_composition`, `validate_ui`)
- ✅ `nextSteps` is a deterministic, machine-readable order
- ❌ no enforced harness (the agent can skip steps; nothing blocks final output)
- ❌ no MCP prompt named e.g. `harness_workflow` that codifies the loop
- ❌ no "repair until clean" loop tool

**Status:** the building blocks are there; the deterministic workflow / harness is not yet packaged as a single resource or prompt.

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
- ❌ design://workflow — not a resource yet (the harness contract from #8)

**Status:** all entity types are exposed; rules and workflow URIs are not.

---

## 10. MCP Prompts — 🟡 partial

`src/server/registrations.ts` `registerPrompts()` registers every prompt loaded from the source repo's `prompts/*.prompt.md`. The fixture has one (`build_with_design_system`).

- ✅ wiring is done (any prompt added by UX shows up in `prompts/list` automatically)
- 🟡 the named prompts the spec called out exist as concepts but only `build_with_design_system` ships in the fixture
- ❌ `review_ui_against_design_system` not in fixture
- ❌ `repair_design_violations` not in fixture
- ❌ `choose_component` not in fixture
- ❌ `migrate_to_design_system` not in fixture

**Status:** infrastructure is complete; the prompt content itself is the source repo's responsibility, not this server's. We can ship more starter prompts in `tests/fixtures/design-systems/sample/prompts/` as templates.

---

## 11. Similarity / Alternatives — 🟡 partial

`src/tools/recommend-composition.ts` returns up to N components ranked by MiniSearch BM25 score, plus their constraints.

- ✅ ranking by intent + platform + framework (concatenated into the search query)
- 🟡 "similar components" — implicit (top-N hits are functionally similar by score)
- ❌ explicit "alternative components" relation
- ❌ "deprecated → replacement" suggestion in this tool (the schema supports `status: deprecated` per component but no automatic replacement path)
- ❌ "why this component, not that one" reasoning
- ❌ explicit ranking by status (stable beats experimental beats deprecated)

**Status:** intent-driven ranking works. Alternatives, deprecation paths, and explanations don't.

---

## 12. Deterministic Decision Explanations — ❌ missing

There is no `explain_decision` tool, and no provenance trail attached to recommendations or violations beyond:

- `DesignConstraint.rationale` field exists in the schema (`src/bundle/schema.ts`) but is free-form text supplied by the source repo, not generated by the server
- `get_usage` echoes constraints, including their rationale
- Violations carry `ruleId` but not the source entity that motivated the rule

**Status:** not implemented as a first-class concept. Would require attaching `provenance: { entityId, ruleId, sourcePath }` to every violation and recommendation.

---

## 13. Violation Repair Suggestions — 🟡 partial, improved

`Violation` type (`src/bundle/types.ts`) has optional `suggestion?: string`, `replaceWith?: string`, and `provenance?: ViolationProvenance` fields. `validate_ui` exposes those fields in its public output schema (`src/tools/validate-ui.ts`).

- ✅ accessibility rules (`src/validation/accessibility.ts`)
- ✅ copy rules (`src/validation/copy.ts`)
- 🟡 token rules — partial (some return suggestions, some don't)
- ✅ source-repo regex rules now carry provenance (`rulePath`) through `src/validation/regex.ts`
- 🟡 deterministic `replaceWith` exists only where a single correct edit is known, e.g. removing `autoFocus`

What's NOT in the suggestion:

- 🟡 machine-readable replacement is present for a subset of rules, not all violations
- 🟡 source-entity reference exists for token primitive warnings and copy/voice violations, but not all rules have a natural entity target
- ❌ before/after snippet
- ❌ structured severity hierarchy beyond `error | warning | info`

**Status:** structured repair payload is now part of the `validate_ui` contract, but coverage is intentionally conservative.

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

## 15. Design Decision Trace — 🟡 partial

The repo now has a `provenance` payload on `validate_ui` violations:

- ✅ source-repo regex rules include `rulePath`
- ✅ built-in rules identify `ruleSource: "built-in"`
- ✅ primitive token warnings link to the token entity + source path
- ✅ copy/voice violations link to the loaded voice entity + source path
- ❌ recommendations (`recommend_composition`) still return entities + constraints, not "why"
- ❌ no relation-path trace yet for recommendations or composition validation

**Status:** implemented for `validate_ui` violations; still missing for recommendations and composition decisions.

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

## 17. Deprecation and Migration — 🟡 partial

The schema supports `status: "stable" | "experimental" | "deprecated"` on component metadata (`src/bundle/schema.ts`). Beyond that:

- ✅ deprecated components flagged
- ❌ deprecated **props** — no per-prop status field on `ComponentPropSchema`
- ❌ deprecated **tokens** — no `deprecated` field on token entities
- ❌ replacement IDs (no `replacedBy: string` field anywhere)
- ❌ migration examples (no schema for them)
- ❌ hard errors for forbidden legacy usage (no rule enforces "do not import deprecated components")

**Status:** component-level status flag only. No prop/token deprecation, no replacement chain, no enforcement.

---

## 18. CI / PR Validation Mode — 🟡 partial

There is now a CLI path for invoking `validate_ui` outside MCP:

- ✅ `pnpm validate` script in `package.json`
- ✅ `src/validate-cli.ts` reads file(s), loads a local design-system source, invokes `validate_ui`, prints JSON, and exits `1` on error violations
- ✅ integration coverage in `tests/integration/validate-cli.test.ts`
- ❌ SARIF output mode
- ❌ `validate_composition` batch mode

**Status:** JSON CI validation is implemented for generated UI files. SARIF and composition-plan batch validation remain open.

---

## 19. Bundle Quality Checks — 🟡 partial

`src/tools/inspect-coverage.ts` (175 LOC) reports issues at refresh time:

- ✅ schema completeness (`required-type-missing-from-schema`, `declared-type-empty`)
- ✅ missing related entity (`relation-target-missing`)
- ✅ duplicate entity ids (handled at build time in `src/bundle/builder.ts:43-49` with `duplicates` warning)
- ✅ component-side gaps (`component-import-missing`, `component-dependencies-empty`, `component-props-empty`, `component-examples-empty`, `component-principles-empty`)
- 🟡 invalid token references — Style Dictionary throws on broken refs (`brokenReferences: "throw"` in `src/bundle/tokens.ts:42`); not surfaced through `inspect_coverage` separately
- ❌ examples-compile sanity (no parser / type-checker on example code blocks)
- ❌ orphan components / patterns (no "used by zero patterns" check)
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

## 21. AST-Based Validation — ❌ missing for rules

Built-in `accessibility.ts`, `copy.ts`, `tokens.ts` use **regex-based heuristics** even on TSX (e.g., `accessibility.ts` regex-matches `<input ... />` patterns, not real JSX AST).

The `RuleDetector` union type (`src/bundle/types.ts`) is currently:

```ts
export type RuleDetector = RegexDetector;
```

The earlier plan called for `regex | ast | plugin` detectors; only `regex` exists.

- ✅ AST is used for component metadata extraction (`src/bundle/component-api.ts`, `src/bundle/storybook.ts`)
- ❌ AST is NOT used for validation rules
- ❌ no JSX-prop-value rule kind
- ❌ no className/token-usage AST rule
- ❌ no plugin escape hatch

**Status:** regex-only for rule execution. AST exists in build-time parsing but not in runtime validation.

---

## 22. Design-System Coverage Report — 🟡 partial

The `inspect_coverage` tool answers part of this:

- ✅ which components lack examples / constraints / principles / props / dependencies
- ✅ which schema types are declared but empty
- ✅ which entities reference missing relation targets
- ❌ which tokens are unused (no token-usage scan)
- ❌ which patterns lack validation contracts (no check on missing `data.contract`)
- ❌ which entities are orphaned across the relation graph
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

## 24. Harness-Enforced Modes — ❌ missing

The repo has no mode flag, no state machine, no "agent must validate before final output" enforcement.

The `recommend_composition` `nextSteps` output is **advisory** — the agent can ignore it. Nothing in this server forces:

- ❌ `plan_only` mode
- ❌ `generate` mode
- ❌ `validate` mode
- ❌ `repair` mode
- ❌ `final_check` gate that blocks output until all error-severity violations are resolved

This is a harness-side feature (the client / IDE / agent loop), not really a server-side feature. The MCP server can publish a workflow as a prompt / resource (#8), but it cannot enforce that an agent runs it.

**Status:** not implemented and arguably not implementable from inside the MCP server alone — needs a client-side or harness-side enforcement layer.

---

# Summary

| # | Feature | Status |
|---|---|---|
| 1 | Component API parser | 🟡 partial (props + variants AST; no defaults, no @deprecated, no controlled detection) |
| 2 | Storybook parser | 🟡 partial (examples + args; no controls, no play, no states) |
| 3 | MDX documentation parser | 🟡 partial (search-clean body; no structured do/don't / tables) |
| 4 | Accessibility rule engine | ✅ 6 rules (no ARIA roles, dialog focus, contrast) |
| 5 | Semantic token validator | ✅ 4 rules (no category enforcement, no per-component allowlists) |
| 6 | Composition validator v2 | 🟡 partial (structural; no ordering / state / platform) |
| 7 | Pattern contract schema | ✅ structural shape (no interaction / copy / a11y fields) |
| 8 | Design brief / harness contract | 🟡 advisory `nextSteps`; no enforced workflow prompt/resource |
| 9 | MCP resources | ✅ all entity types + per-type templates (no `tokens/{category}`, `rules`, `workflow`) |
| 10 | MCP prompts | 🟡 wiring complete; only one starter prompt in fixture |
| 11 | Similarity / alternatives | 🟡 BM25 ranking; no explicit alternatives or "why-not" |
| 12 | Deterministic decision explanations | ❌ no `explain_decision` tool, no provenance |
| 13 | Violation repair suggestions | 🟡 structured payload exists for selected rules; no before/after snippets |
| 14 | Copy / voice validator | ✅ 4 rules (no glossary / reading-level / per-surface tone) |
| 15 | Design decision trace | 🟡 provenance exists on validate_ui; no recommendation trace yet |
| 16 | Component dependency / import guidance | ✅ schema'd; surfaced via `get_usage` |
| 17 | Deprecation and migration | 🟡 component `status` only; no prop / token deprecation, no `replacedBy` |
| 18 | CI / PR validation mode | 🟡 JSON validate_ui CLI exists; no SARIF / composition batch |
| 19 | Bundle quality checks | 🟡 structural + metadata coverage via `inspect_coverage`; no orphan / compile / stale-replacement |
| 20 | Framework adapters | 🟡 language flag covers tsx/jsx/ts/js/css/html/vue (no React Native; no per-framework AST) |
| 21 | AST-based validation rules | ❌ regex-only `RuleDetector`; AST is build-time only |
| 22 | Design-system coverage report | 🟡 component-side coverage via `inspect_coverage`; no token-usage / orphan checks |
| 23 | Strict schema specs | 🟡 strong for component / pattern / rule; weak for token / migration / platform |
| 24 | Harness-enforced modes | ❌ server can advise (`nextSteps`), cannot enforce |

**Tally:** 6 ✅ · 15 🟡 · 3 ❌ (out of 24).

The missing/major-gap set (12, 21, 24, plus the remaining recommendation side of 15 and SARIF/composition side of 18) clusters into three real gaps:

- **Provenance & explanations** (12, remaining 15) — `validate_ui` violations now have provenance; recommendations still need a trace, then an `explain_decision` tool/resource can be built.
- **AST-based rules** (21) — `RuleDetector` union extension to `RegexDetector | AstDetector | PluginDetector`, then per-language adapters. Real engineering work.
- **CI mode + harness enforcement** (remaining 18, 24) — JSON `validate_ui` CLI exists; SARIF/composition mode and harness enforcement are still open.

The 13 partials are mostly "the surface exists but the depth doesn't" — rules can be added (each is ~20-40 LOC), schema fields can be extended.

For each item that's worth promoting from 🟡 to ✅, the cheapest path is:

| Promote | Approach |
|---|---|
| #1 Component API → defaults | Add a value-extractor in `component-api.ts:readProps` for `member.initializer` (when `PropertySignature` is in a `ParameterDeclaration`-like position) |
| #4 Accessibility → +ARIA roles + dialog | Add 2-3 more rule entries to `accessibility.ts` |
| #5 Tokens → category enforcement | Add a 5th rule keyed off the token's `$type` field |
| #7 Pattern contract → +copy + interaction | Extend `PatternContractSchema` with `copyRules: string[]`, `interactionRules: string[]` |
| #11 Alternatives | Add a `findAlternatives(entity)` helper that walks `related` + same-type ranked-by-status |
| #13 Repair → structured | Extend `replaceWith` coverage and add before/after snippets where fixes are deterministic |
| #17 Deprecation → tokens + props | Add `deprecated?: { since?, replacedBy? }` to `ComponentPropSchema` and to token entities |
| #18 CI mode | Add SARIF output and optional `validate_composition` batch input |
| #22 Coverage → orphan + token-usage | New checks in `inspect-coverage.ts` |

If you want any of these landed, the cheapest 5 in priority order would be:

1. **#18 CI / PR validation mode** — JSON CLI is in; next value is SARIF output for GitHub code scanning plus optional composition-plan validation.
2. **#13 Structured repair suggestions** — extend `replaceWith` beyond autofocus and add before/after snippets.
3. **#11 Explicit alternatives** — improves agent decision quality; small change to `recommend_composition`.
4. **#15 Recommendation provenance** — add trace payloads to `recommend_composition`; needed before #12 explain_decision can cover decisions.
5. **#21 AST detector kind** — biggest engineering investment of the bunch but unblocks deeper validation of token-usage-in-JSX, controlled-vs-uncontrolled, etc.

Each is a discrete slice that fits a TDD-RED→GREEN→Critic cycle.
