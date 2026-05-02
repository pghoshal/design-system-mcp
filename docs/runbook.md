# Runbook — operating the design-system MCP server

> Audience: the on-call operator. This file pairs with `docs/client-setup.md` (what end users see).

This server is **single-instance** by design. There is no cluster, no Redis, no DB, no object store. State is the in-memory bundle, derived from a Git checkout on disk. Recovery procedures are correspondingly simple: when in doubt, restart the container.

---

## Quick reference

| Question | Answer |
|---|---|
| What's the current bundle version? | `GET /version` |
| Is the server healthy? | `GET /healthz` (alive) and `GET /readyz` (bundle loaded) |
| Force a refresh now (skip the polling interval) | `POST /admin/refresh` with `Authorization: Bearer $DS_MCP_ADMIN_TOKEN` |
| What environment knobs exist? | `src/config.ts` and `.env.example` |
| Where do logs go? | stdout (HTTP mode) / stderr (stdio mode); structured JSON via Pino |
| Where is the Git checkout on disk? | `$DS_MCP_CACHE_DIR/<derived-slug>/` (default `~/.cache/ds-mcp`) |

---

## Deploy

The CI pipeline at `.github/workflows/ci.yml` runs lint + typecheck + test + build on every PR.

Deploy targets and their entry points:

- **Fly.io:** `fly deploy --config deploy/fly/fly.toml`
- **Kubernetes:** `kubectl apply -f deploy/k8s/`
- **Plain VPS / docker-compose:** `docker compose up -d`

In all cases the rollout strategy is **recreate** (single instance, brief unavailability acceptable). Do not configure rolling updates with `replicas > 1` — the codebase is intentionally single-instance.

### Pre-deploy checklist

1. `pnpm test` green locally (we trust CI but check before urgent ships)
2. `git tag v$(node -p "require('./package.json').version")` and push, so the image is tagged immutably
3. Confirm secrets are present in the target environment: `DS_MCP_API_KEYS` (if `AUTH_MODE=apikey`), `DS_MCP_ADMIN_TOKEN`, `GIT_AUTH_TOKEN` (HTTPS clones), or SSH key (SSH clones)
4. Confirm `DS_MCP_SOURCE_URL` points at the right repo and branch

### Rollback

The fastest rollback is to redeploy the previous image tag. Image tags are immutable git SHAs.

```bash
# Fly.io example
fly releases --app ds-mcp-server          # find the previous version
fly releases rollback <version> --app ds-mcp-server
```

Bad **content** (a bad merge to the source design-system repo) does not require a server rollback — revert the offending commit upstream and `POST /admin/refresh` to pull immediately.

---

## Health & probes

| Endpoint | When 200 | When 503 |
|---|---|---|
| `/healthz` | Process alive | Never returns 503; container should be killed if unreachable |
| `/readyz` | Bundle loaded, not draining | Bundle still loading on boot, or `beginDrain()` was called during shutdown |
| `/version` | Always | — (always returns 200 with build + bundle info) |

**`/readyz` is the only probe a load balancer should use.** `/healthz` is for the orchestrator's restart policy.

A `/readyz` 503 stuck for more than ~10 seconds after boot indicates a bundle build failure. Check logs for `bundle built` (success) or `refresh failed; keeping current bundle` (failure with stale bundle still serving) or no message at all (parser blew up before reaching the log).

---

## Refresh

The server pulls the source repo every `DS_MCP_REFRESH_INTERVAL_SEC` seconds (default 300). When new commits arrive, the bundle is rebuilt and atomically swapped — clients never see a partial or torn state.

To force a refresh out of band:

```bash
curl -fsS -XPOST \
  -H "Authorization: Bearer $DS_MCP_ADMIN_TOKEN" \
  https://ds-mcp.your-org.example/admin/refresh
# → 202 Accepted
# {"accepted":true,"changed":true,"version":"abc1234-2026-05-02T..."}
```

`changed: false` means the remote was already at the local tip — no rebuild happened.

---

## Logs

All server output is structured JSON via Pino. Pino redaction (configured in `src/observability/logger.ts`) masks `req.headers.authorization`, `req.headers.cookie`, and any field with key `apiKey`, `secret`, `token`, `password`, or `privateKey`. **Full request and response bodies are NOT redacted by default** — rely on the configured field-name redaction and avoid logging entire bodies in any new code.

Key event lines you'll see in production:

| Message | Meaning |
|---|---|
| `ds-mcp-server starting` | Boot. Has `mode`, `sourceMode`, `logLevel`. |
| `git: cloning` | First-run clone for `DS_MCP_SOURCE_MODE=git` |
| `git: pulled new commit(s)` | Refresh found new content; rebuild follows |
| `loaded tokens`, `loaded markdown entities`, `loaded prompts`, `loaded rules` | Per-stage bundle build counts (each line carries a `count` field) |
| `bundle built` | Build succeeded with timing + entity counts (`durationMs`, `entityCount`, `tokens`, `markdown`, `prompts`, `rules`) |
| `bundle swapped` | Atomic ref swap completed; `from` + `to` version strings |
| `scheduled refresh failed` | Background refresh threw; previous bundle still serving |
| `git: update failed` | Git pull failed (auth, network, branch deleted); previous bundle still serving |
| `tool ok` / `tool error` | Per-tool-call entry with `tool`, `requestId`, `durationMs`, `status`; errors also carry `code` |
| `http transport listening` | HTTP mode bound and serving (carries `port`, `authMode`) |
| `http transport: drain initiated` | SIGTERM received; `/readyz` will start returning 503 |

### Log queries (operator examples)

| Question | Filter |
|---|---|
| Are tools succeeding? | `msg=="tool ok"` rate vs `msg=="tool error"` rate |
| Why did the agent's last call fail? | `msg=="tool error"` filtered by `requestId` from the client |
| Did the last refresh work? | `msg=="bundle swapped"` (success) or `msg=="refresh failed; keeping current bundle"` (failure) |
| Is the server stuck on an old bundle? | Compare `to` field on the most recent `bundle swapped` against the source repo's HEAD |

Pino log lines are one-JSON-object-per-line so any tool that handles JSONL (jq, grep, ripgrep, log aggregator) works.

---

## Common alarms and what to do

### Alarm: `/readyz` 503 for more than 60 seconds

- Container is alive (`/healthz` 200) but the bundle isn't loading
- Check stderr/log sink for `refresh failed`, parser errors, or Style Dictionary reference cycles
- Most common cause: a bad merge to the source repo. Revert upstream and `/admin/refresh`.
- If logs are clean, restart the container — the in-memory bundle is rebuilt from disk on cold start

### Alarm: refresh failures sustained for >30 minutes

- Source repo unreachable, credentials expired, or branch deleted/renamed
- Check the most recent `git: update failed` log line for the underlying error (network, auth) and `scheduled refresh failed` for downstream rebuild errors
- If credentials expired, rotate `GIT_AUTH_TOKEN` (HTTPS) or the deploy key (SSH)
- If the branch was renamed, update `DS_MCP_SOURCE_BRANCH` and redeploy
- Until fixed, the server keeps serving the last-known-good bundle — clients are not impacted, just stale

### Alarm: tool error rate >1% sustained for 5 minutes

- Inspect `tool error` log lines for the `code` field
- `not_found` and `invalid_input` indicate client-side bugs, not server problems — find which agent is misbehaving
- `bundle_unavailable` indicates the server lost its bundle (hot-rebuild failed and somehow cleared the ref); restart the container
- `internal` indicates an unhandled error path; capture the `requestId` and stack trace from the log line, file an issue

### Alarm: container restart count climbing

- Check stderr just before each restart — `uncaughtException` or `unhandledRejection` will be the last log line
- These should not happen in steady state; treat as a real bug
- Workaround: set the orchestrator's restart policy to back off, so a tight crash loop doesn't burn CPU

### Alarm: `/admin/refresh` returns 401

- Either `DS_MCP_ADMIN_TOKEN` isn't set in the running container's environment
- Or the operator used the wrong token
- Check `/version` — if `DS_MCP_ADMIN_TOKEN` was misconfigured, the env var may be missing entirely; redeploy with the secret in place

---

## Server fails to start

Symptoms: container exits immediately, or `/readyz` never reaches 200.

1. **Look at stderr.** Boot logs go to stderr in stdio mode, stdout in HTTP mode (Pino destination is mode-aware — see `src/observability/logger.ts`).
2. **Invalid config:** `Invalid configuration:` followed by a Zod error. The most common cause is a missing required env var (e.g., `DS_MCP_SOURCE_URL` when `DS_MCP_SOURCE_MODE=git`).
3. **Git clone failure:** check the `git: cloning` line and any subsequent error. Auth failure, branch not found, or network unreachable. Validate by running the same `git clone` command locally with the same credentials.
4. **Style Dictionary reference cycle:** the boot log will surface a chain like `{color.action.primary} → {color.action.primary}`. Fix in the source repo.
5. **Manifest schema rejection:** `manifest.json failed schema validation` — the source repo's manifest.json is malformed. Diff against the source-repo's PR validation workflow output.

---

## Disaster recovery

| Scenario | RTO | Action |
|---|---|---|
| Container crash | <30 s | Orchestrator restarts; cold start re-clones from source repo |
| Source repo unreachable | indefinite | Server keeps serving last-known-good bundle until restored |
| Bad content merged | <`REFRESH_INTERVAL_SEC` | Revert upstream + `/admin/refresh`; or rollback the commit that introduced the bad content |
| Cache dir disk full | <2 min | Operator clears `$DS_MCP_CACHE_DIR`; container restart; clone happens fresh |
| Source repo lost (deleted) | up to GitHub-restore time | Restore from GitHub backup or mirror; update `DS_MCP_SOURCE_URL` if URL changed |
| Compromised admin token | <5 min | Rotate `DS_MCP_ADMIN_TOKEN`, redeploy. No persistence of admin actions to roll back. |
| Compromised API key | <5 min | Remove that key's hash from `DS_MCP_API_KEYS`, redeploy. Issue a new key to legitimate clients. |

There is no persistent server state to back up — the entire system is a stateless function of the Git source repo plus runtime config. The Git repo is the only thing that needs durable backup, and GitHub handles that.

---

## Capacity & sizing

The baseline capacity assumption (roughly 50 engineers × 40 sessions/hour × 5 calls per session, or about 30 RPS peak) fits comfortably in 1 vCPU / 512 MB. If observed usage exceeds those numbers and shows real load:

- **Vertical first.** Bump CPU and memory.
- **Horizontal is out of scope.** Adding replicas is not a config change; the codebase has explicit single-instance assumptions. Multi-instance is a fresh design proposal, not a runbook step.

Memory red flag: RSS climbing without bound across refreshes suggests the old bundle isn't being GC'd because something still references it. Capture a heap dump and file an issue.

---

## What this runbook does not cover

- The source design-system repo's own CI / PR validation — that lives in the source repo, not here
- Figma export workflows — handled by UX team tooling
- Client-side IDE config — see `docs/client-setup.md`
- Multi-tenancy, SSO, and regional fail-over are explicitly out of scope for this single-instance server.
