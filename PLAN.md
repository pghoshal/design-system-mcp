# Design System MCP Server — Single-Instance Plan

> **Status:** Planning v2 (simplified)
> **Owner:** Prasenjit Ghoshal
> **Last updated:** 2026-05-01

---

## 0. Context

The UX team maintains a design system in Figma + a Git repo of `tokens.json` + markdown. Engineers use Claude Code / Cursor / Claude Desktop to generate UI. Today the agent does not know the design system, so it generates code that violates tokens, principles, components, and voice.

Goal: a small **single-instance MCP server** that any agentic client can connect to, that returns authoritative design system context at request time, with the lowest possible operational complexity.

Decisions locked in this revision:
- **Single instance.** No multi-instance, no replicas, no cluster.
- **No Redis.** No object store. No bundle pipeline. No external state.
- The server reads the design-system Git repo directly (a local clone), runs Style Dictionary in-process, builds a manifest + MiniSearch index in memory, and serves MCP.
- Periodic `git pull` (default every 5 min) refreshes content; on change, the in-memory index is rebuilt and atomically swapped.
- Two transports: **stdio** (local IDE) and **Streamable HTTP** (hosted single instance).
- Generic-verb tools, schema-in-data manifest. (Unchanged from v1 plan.)

This document is the master architecture plan. Detailed governance lives in `.claude/`.

---

## 1. High-Level Architecture

```
                    ┌────────────────────────────────────┐
                    │   Design System Git Repo (private) │
                    │   - tokens (DTCG)                  │
                    │   - principles, patterns, voice    │
                    │   - component metadata             │
                    │   - manifest schema                │
                    │   - prompts                        │
                    └─────────────────┬──────────────────┘
                                      │ git clone (once) +
                                      │ git pull (every 5 min)
                                      ▼
        ┌────────────────────────────────────────────────────┐
        │         MCP Server (single Node.js process)        │
        │                                                    │
        │  Loader ───► Style Dictionary ───► Manifest        │
        │     │                                  │           │
        │     ├──► Markdown parse ───────────────┤           │
        │     │                                  │           │
        │     └──► Component metadata parse ─────┤           │
        │                                        │           │
        │                                        ▼           │
        │                            ┌────────────────────┐  │
        │                            │ In-memory Bundle    │  │
        │                            │  + MiniSearch index │  │
        │                            │  + LRU cache (L1)   │  │
        │                            └────────┬───────────┘  │
        │                                     │              │
        │  ┌──────────────────────────────────▼──────────┐  │
        │  │  MCP Tools / Resources / Prompts             │  │
        │  └──────────────────┬──────────────────────────┘  │
        │                     │                              │
        │           stdio  ◄──┴──►  Streamable HTTP          │
        └─────────────────────┬──────────────────────────────┘
                              │
                              ▼
                       Clients (Claude Code,
                       Cursor, Claude Desktop,
                       custom agents)
```

**Invariants:**
1. **Single Node.js process.** No coordination layer.
2. **In-memory bundle.** Built at startup and on each `git pull` that finds new commits.
3. **Atomic ref swap** for hot-rebuilds — in-flight requests use the old bundle until they complete; new requests get the new one. No restart required for content changes.
4. **No external state stores.** No Redis, no DB, no S3. Fail-stop is acceptable; the server boots back fast.
5. **Schema-in-data.** New content types are added by editing `manifest.json` in the source repo.

---

## 2. Tech Stack (locked)

| Concern | Library | Why |
|---|---|---|
| Language | TypeScript / Node 22 LTS | Best MCP SDK support |
| HTTP server | Fastify | Used only in HTTP transport mode |
| MCP | `@modelcontextprotocol/sdk` | Official SDK (Streamable HTTP + stdio) |
| Validation | Zod | Boundary validation, schema inference |
| Token processing | Style Dictionary v4 | DTCG standard, in-process |
| Markdown | gray-matter + unified/remark | Frontmatter + AST |
| Search | MiniSearch | BM25, ~50KB, in-process, sufficient for <5k entities |
| Cache | lru-cache | In-process L1 only |
| Git | simple-git | Clone + pull |
| Logging | Pino | Fast structured logs |
| ID generation | uuid | Request IDs |
| Test runner | Vitest | Fast, ESM-native |
| Linter / formatter | Biome | Single-tool replacement for eslint+prettier |

**Removed from v1 plan:** ioredis, redlock, @aws-sdk/client-s3, tar, @mongodb-js/zstd, prom-client, OpenTelemetry SDK, @fastify/jwt, @fastify/oauth2, @fastify/rate-limit. (Any can be re-added if a real need emerges.)

---

## 3. Source Repo Layout

The design-system source repo (a separate repo, not this one) is structured as:

```
design-system/                          # private GitHub repo
├── tokens/
│   ├── core.tokens.json                # DTCG primitives
│   ├── semantic.tokens.json            # aliases
│   └── components.tokens.json          # per-component tokens
├── docs/
│   ├── principles/*.md
│   ├── voice-and-tone.md
│   ├── patterns/*.md
│   └── conventions/*.md
├── components/                         # added when React lib exists
│   └── Button/
│       ├── Button.tsx
│       ├── Button.stories.tsx
│       └── README.md
├── prompts/
│   └── *.prompt.md
├── manifest.json                       # the schema declaration
├── style-dictionary.config.js
└── .github/workflows/
    └── validate-pr.yml                 # lint + schema check on PR (optional)
```

UX team owns tokens + docs. Engineering owns components + conventions. Both review each other's PRs.

---

## 4. Data Flow

### 4.1 Cold start
1. Server starts → loads config (env vars, validated by Zod)
2. If `SOURCE_MODE=git`: `git clone <url> <cacheDir>` (or `git pull` if exists)
3. If `SOURCE_MODE=local`: skip clone, use the configured local path
4. Walk the tree:
   - Resolve tokens via Style Dictionary
   - Parse markdown with gray-matter + remark
   - Parse component metadata from `components/*/component.json`
   - Build manifest from `manifest.json` declaration + walked entities
   - Build MiniSearch index in memory
5. Atomically install the bundle as the current bundle
6. Start transport (stdio or Streamable HTTP)
7. Mark `/readyz` 200 (HTTP mode only)

### 4.2 Tool request
1. Client sends MCP `tools/call`
2. Tool handler reads from current bundle
3. May consult LRU cache (keyed by `bundleVersion`)
4. Returns result; logs the call

### 4.3 Refresh (background)
Every `REFRESH_INTERVAL_SEC` (default 300):
1. `git pull --ff-only`
2. If no new commits, no-op
3. Else: rebuild bundle (Style Dictionary + walk + index)
4. Atomic ref swap
5. Old bundle dropped after last in-flight request completes

### 4.4 Refresh (manual)
The MCP server exposes an admin endpoint `POST /admin/refresh` (HTTP mode, requires admin token) to force a refresh on demand. Useful right after a UX team merge.

---

## 5. Tool Surface

Generic verbs only. New content types do **not** require new tools.

```ts
search_design_system(query, type?, filters?, limit?, offset?) → SearchResult[]
get_entity(id, fields?, resolve_relations?) → Entity
list_entities(type?, tag?, page?, page_size?) → PagedEntityList
describe_schema() → SchemaDefinition
get_related(id, relation?, direction?) → Entity[]
resolve_token(query, platform?) → TokenMatch[]
validate_ui(code, language?, rules?) → ValidationReport   // Phase 3
get_usage(id, language?, include_constraints?) → CanonicalUsage
recommend_composition(intent, platform?, framework?, limit?) → ImplementationBrief
validate_composition(components, pattern?, tokens?) → CompositionValidation
```

**Resources** (URI-addressable):
- `design://manifest`
- `design://schema`
- `design://entity/{id}`
- `design://tokens/{category}`
- `design://principle/{id}`
- `design://pattern/{id}`
- `design://component/{id}`

**Prompts**: auto-discovered from `prompts/*.prompt.md` in the source repo.

---

## 6. Repository Layout (this server)

```
design-system-mcp/
├── PLAN.md                             ← this file
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── biome.json
├── vitest.config.ts
├── Dockerfile
├── docker-compose.yml                  # local: just the server
├── .env.example
├── .gitignore
├── .dockerignore
│
├── .claude/                            # governance docs
│   ├── context.md
│   ├── hallucinate.md
│   ├── allow-deny.md
│   ├── project.md
│   ├── blueprint.md
│   ├── hld.md
│   ├── lld.md
│   ├── flows.md
│   ├── db.md
│   ├── deployment.md
│   └── Progress.md
│
├── .github/
│   └── workflows/
│       └── ci.yml                      # lint + test + build
│
├── src/
│   ├── index.ts                        # entry: chooses transport
│   ├── config.ts                       # Zod-validated env
│   │
│   ├── transport/
│   │   ├── stdio.ts
│   │   └── http.ts                     # Streamable HTTP via Fastify
│   │
│   ├── server/
│   │   ├── mcp.ts                      # MCP SDK wiring
│   │   ├── lifecycle.ts                # boot + shutdown
│   │   └── health.ts                   # /healthz, /readyz, /version
│   │
│   ├── source/
│   │   ├── manager.ts                  # SourceManager: clone, pull, refresh
│   │   ├── git.ts                      # simple-git wrapper
│   │   └── local.ts                    # local-path adapter
│   │
│   ├── bundle/
│   │   ├── builder.ts                  # walk repo → Bundle
│   │   ├── tokens.ts                   # Style Dictionary integration
│   │   ├── markdown.ts                 # gray-matter + remark
│   │   ├── manifest.ts                 # parse manifest.json
│   │   ├── schema.ts                   # manifest + frontmatter + rule schemas
│   │   ├── rules.ts                    # load JSON validation rules
│   │   └── types.ts
│   │
│   ├── search/
│   │   └── minisearch.ts               # build + query
│   │
│   ├── validation/
│   │   └── regex.ts                    # validate_ui detector helpers
│   │
│   ├── tools/                          # one file per tool
│   │   ├── search-design-system.ts
│   │   ├── get-entity.ts
│   │   ├── list-entities.ts
│   │   ├── describe-schema.ts
│   │   ├── get-related.ts
│   │   ├── resolve-token.ts
│   │   └── validate-ui.ts              # Phase 3
│   │
│   ├── resources/
│   │   └── handlers.ts
│   │
│   ├── prompts/
│   │   └── loader.ts
│   │
│   ├── observability/
│   │   └── logger.ts                   # Pino setup
│   │
│   └── util/
│       ├── lru.ts
│       ├── atomic-ref.ts
│       ├── errors.ts
│       └── ids.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│       └── design-systems/
│           └── sample/                 # tiny test design system
│
└── docs/
    ├── client-setup.md                 # connect Claude Code/Cursor/Desktop
    └── runbook.md
```

---

## 7. Configuration (env vars)

| Var | Required | Default | Notes |
|---|---|---|---|
| `DS_MCP_MODE` | yes | `http` | `http` \| `stdio` |
| `DS_MCP_SOURCE_MODE` | yes | `git` | `git` \| `local` |
| `DS_MCP_SOURCE_URL` | iff git | — | HTTPS Git URL |
| `DS_MCP_SOURCE_BRANCH` | no | `main` | which branch to track |
| `DS_MCP_SOURCE_PATH` | iff local | — | path to a checked-out design-system repo |
| `DS_MCP_CACHE_DIR` | no | `~/.cache/ds-mcp` | where to clone the repo |
| `DS_MCP_REFRESH_INTERVAL_SEC` | no | `300` | git pull interval |
| `PORT` | no | `3000` | HTTP listen port |
| `LOG_LEVEL` | no | `info` | trace/debug/info/warn/error/fatal |
| `DS_MCP_AUTH_MODE` | no | `none` | `none` \| `apikey` |
| `DS_MCP_API_KEYS` | iff apikey | — | comma-separated SHA-256 hex digests |
| `DS_MCP_ADMIN_TOKEN` | no | — | bearer for `/admin/refresh` |

---

## 8. Implementation Roadmap

### Phase 0 — Skeleton (Week 1)
- Repo bootstrap (package.json, tsconfig, Biome, Vitest)
- CI (lint + test on PR)
- MCP server scaffolding with stdio transport
- One smoke test: `describe_schema()` returns `{}`

### Phase 1 — Local source + tools (Week 2)
- `SOURCE_MODE=local` adapter
- Token loading via Style Dictionary
- Markdown loading via gray-matter + remark
- Manifest parsing
- MiniSearch indexing
- Tools: `search_design_system`, `get_entity`, `list_entities`, `describe_schema`
- Resources: `design://manifest`, `design://entity/{id}`
- Sample fixture design system in `tests/fixtures/`

### Phase 2 — Git source + HTTP transport + refresh (Week 3)
- `SOURCE_MODE=git` adapter (clone + pull)
- Streamable HTTP transport via Fastify
- Background refresh loop with atomic-ref swap
- `/healthz`, `/readyz`, `/version`
- `/admin/refresh` endpoint
- Optional API key auth
- Logging (Pino with redaction)

### Phase 3 — Validation tool (Week 4)
- `validate_ui` with simple regex rules
- Rules sourced from the design-system repo (`rules/*.json`)
- Returns structured violations

### Phase 4 — Enterprise hardening (started)
- Component metadata ingestion from `components/*/component.json`
- Canonical usage examples, imports, props, and constraints
- Composition recommendation and composition/prop validation

Completed in the first Phase 4 slice above. Remaining hardening:

- Storybook story parser (when components exist)
- Test suite (unit + integration with a real fixture)
- Container build + deployment docs

### Phase 5 — Production rollout
- Deploy single instance on Fly.io / Railway / VPS
- Connect pilot engineers' IDEs
- Iterate based on observed query patterns

### Phase 6 — Enterprise design consistency
- Pattern contract schema + enforcement in `validate_composition`
- Implemented: TypeScript component parser for `.tsx` / `.jsx` public `*Props` APIs
- MDX documentation parser
- Storybook story parser for examples and variants
- Implemented: accessibility validation rules for image alt text, accessible names, labels, tabindex, autofocus
- Implemented: semantic token validation beyond raw hex for raw length values, raw color functions, unknown CSS vars, primitive token warnings
- Implemented: copy/voice validation rules for blame, hype, vague action labels, destructive hedging
- Dependency/import guidance per component package
- Rich relation inference: components ↔ tokens ↔ patterns ↔ principles ↔ validation rules
- Harness workflow docs: discover → recommend → fetch usage → validate composition → generate → validate UI → repair

### Future (not committed)
- Figma MCP server alongside (separate concern)
- Embeddings / semantic search (only if BM25 misses obvious queries)
- Code Connect mappings
- Move to multi-instance only if a clear scaling need emerges

## 8.1 Enterprise Feature Parity Notes

Reviewed `PinoNoir/sds-components-mcp` via LobeHub/GitHub listing. Relevant capabilities to absorb, while preserving this project's generic-verb and read-only rules:

| Capability | This project mapping |
|---|---|
| Component search | Existing `search_design_system` with `type=component` |
| Component details | Existing `get_entity` plus `get_usage` |
| Similar/alternative components | `recommend_composition` and `get_related` |
| Prop validation | `validate_composition` |
| Code generation | Out of scope as server-authored code; `get_usage` returns canonical snippets and imports for the harness/LLM to use |
| Component/story/token/doc parsers | Phase 4-6 parser roadmap, with Style Dictionary retained for tokens |

---

## 9. Performance Targets

| Metric | Target |
|---|---|
| `search_design_system` p50 | <30 ms |
| `get_entity` p50 | <5 ms |
| Cold start (boot → ready) | <5 s |
| Refresh (rebuild after `git pull`) | <3 s for ~500 entities |
| Memory | <300 MB at p99 (typical corpus) |

These are easily achievable in a single process with in-memory data.

---

## 10. Failure Modes & Recovery

| Failure | Behavior | Recovery |
|---|---|---|
| Git remote unreachable | Serve last-good in-memory bundle; log; retry on next interval | Resume on next successful pull |
| Bad commit (parse fails) | Reject the new bundle; keep serving last-good; log error; refresh metric records failure | Author fixes upstream; next pull succeeds |
| Process crash | Container/orchestrator restarts | Cold start re-clones and rebuilds |
| Disk full (cache dir) | Refresh fails; log + serve last-good | Operator clears cache or expands disk |
| Source repo deleted/renamed | Refresh fails forever until config updated | Update `DS_MCP_SOURCE_URL`; restart |

There is no "split brain" failure mode because there is no second instance.

---

## 11. Security

- TLS terminated by upstream proxy (Cloudflare Tunnel, Caddy, nginx) — server itself does plaintext on a private port
- Optional API key auth (SHA-256 hex digests compared with `timingSafeEqual`)
- Pino redaction on known-sensitive fields
- Source repo cloned with a deploy key (read-only) or fine-scoped PAT
- Admin token (`/admin/refresh`) separate from API keys, never logged
- No PII stored

---

## 12. Deployment Options

### A. Local stdio (per developer)
```bash
DS_MCP_MODE=stdio DS_MCP_SOURCE_MODE=local DS_MCP_SOURCE_PATH=~/work/design-system pnpm start
```
IDE configures stdio MCP pointing at the binary.

### B. Hosted single instance (org)
- Deploy container to Fly.io / Railway / VPS / single K8s pod
- Cloudflare Tunnel or similar for TLS + auth gate
- Engineers connect via Streamable HTTP

That's it. No load balancer, no Redis, no object store, no orchestrator beyond "make sure the container is running."

---

## 13. What Is Deliberately Excluded

- Multi-instance / replicas
- Redis / external coordination
- Object store / bundle pipeline
- OAuth (API key is sufficient for v1)
- Distributed cache, distributed locks, distributed rate limit
- Metrics + tracing (add only when real operational need emerges)
- Database
- Write tools (server is read-only)
- WebSocket transport
- Multi-tenancy

If any of these become necessary, treat as a separate proposal. Don't quietly add them.

---

## 14. Why This Shape

The previous (v1) plan modeled the system as a horizontally scalable distributed service with Redis coordination, object storage, content-addressed bundles, signed artifacts, and pub/sub fan-out. That is the correct architecture for an enterprise serving thousands of clients across regions.

For a small design system used by an internal team, that machinery is a tax. The simpler shape:

- A single Node process is more than enough for a few hundred users
- Reading Git directly removes the entire bundle pipeline (CI, signing, object store, promotion, hot-swap coordination)
- Removing Redis removes a whole class of failure modes and costs
- Atomic ref swap on rebuild is the only "coordination" needed, and it's a single-line of JavaScript

Trade-offs accepted:
- A bad commit can serve briefly until the next refresh — mitigated by PR validation in the source repo
- No cryptographic verification of content at runtime — acceptable since content lives in a private repo with branch protection and code review
- Single point of failure — mitigated by container orchestrator restart and short cold-start
- Refresh latency up to `REFRESH_INTERVAL_SEC` — mitigated by `/admin/refresh` for urgent updates

The architectural discipline (schema-in-data, generic verbs, clean layering) is preserved. The infrastructure complexity is removed. This is the right shape for the requirement.
