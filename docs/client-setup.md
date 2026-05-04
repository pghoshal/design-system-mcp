# Client setup

How to point an MCP-compatible IDE or custom agent at this server.

The server has two transport modes:

- **stdio** — the client spawns the server as a subprocess and talks over its stdin/stdout. Best for individual developers using a local checkout of the design system.
- **Streamable HTTP** — the server runs as a long-lived process; clients connect over HTTPS. Best for a hosted single instance shared by a team.

Pick stdio when each engineer has their own design-system clone, or when you don't want to operate a server. Pick HTTP when the design system lives on a private GitHub repo and you want a single source of truth for the team.

Throughout this document, replace placeholder values (paths, URLs, tokens) with your environment.

---

## Building the binary

```bash
git clone <this-repo> ds-mcp-server
cd ds-mcp-server
pnpm install
pnpm build
# emits dist/index.js
```

In stdio mode, IDE clients spawn `node /path/to/dist/index.js`. In HTTP mode the same binary runs as a daemon (typically inside a container — see `docs/runbook.md`).

---

## Stdio: against a local checkout

Use this when you (or each developer) already has the design-system repo cloned locally.

The required environment is:

| Variable | Value |
|---|---|
| `DS_MCP_MODE` | `stdio` |
| `DS_MCP_SOURCE_MODE` | `local` |
| `DS_MCP_SOURCE_PATH` | absolute path to the design-system checkout |

### Generic stdio MCP client

Add to your MCP client config file:

```json
{
  "mcpServers": {
    "design-system": {
      "command": "node",
      "args": ["/abs/path/to/ds-mcp-server/dist/index.js"],
      "env": {
        "DS_MCP_MODE": "stdio",
        "DS_MCP_SOURCE_MODE": "local",
        "DS_MCP_SOURCE_PATH": "/Users/you/work/design-system",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Restart the client. The next session should expose the design-system tools.

### Cursor

Cursor reads MCP config from `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "design-system": {
      "command": "node",
      "args": ["/abs/path/to/ds-mcp-server/dist/index.js"],
      "env": {
        "DS_MCP_MODE": "stdio",
        "DS_MCP_SOURCE_MODE": "local",
        "DS_MCP_SOURCE_PATH": "/Users/you/work/design-system"
      }
    }
  }
}
```

### Custom agent SDK example

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["/abs/path/to/ds-mcp-server/dist/index.js"],
  env: {
    DS_MCP_MODE: "stdio",
    DS_MCP_SOURCE_MODE: "local",
    DS_MCP_SOURCE_PATH: "/Users/you/work/design-system",
  },
});

const client = new Client({ name: "my-agent", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log(tools.tools.map((t) => t.name));
```

---

## Stdio: pulling from Git

Use this when the developer doesn't already have the design-system cloned. The server clones once into the configured cache dir and pulls on every refresh.

| Variable | Value |
|---|---|
| `DS_MCP_MODE` | `stdio` |
| `DS_MCP_SOURCE_MODE` | `git` |
| `DS_MCP_SOURCE_URL` | HTTPS or SSH URL to the design-system repo |
| `DS_MCP_SOURCE_BRANCH` | branch name (default `main`) |
| `DS_MCP_CACHE_DIR` | path for the local clone (default `~/.cache/ds-mcp`) |
| `DS_MCP_REFRESH_INTERVAL_SEC` | how often to `git pull` (default `300`) |
| `GIT_AUTH_TOKEN` | optional PAT for HTTPS clones of private repos |

For SSH URLs (`git@github.com:org/repo.git`), the server uses your existing ssh-agent / `~/.ssh` keys — no extra config needed.

For HTTPS URLs of private repos, set `GIT_AUTH_TOKEN` to a fine-scoped PAT with `repo` read access. The token is embedded as basic-auth into the URL only at clone/fetch time and never logged (verify by running with `LOG_LEVEL=debug` and grepping the output).

### Generic stdio MCP client (Git mode)

```json
{
  "mcpServers": {
    "design-system": {
      "command": "node",
      "args": ["/abs/path/to/ds-mcp-server/dist/index.js"],
      "env": {
        "DS_MCP_MODE": "stdio",
        "DS_MCP_SOURCE_MODE": "git",
        "DS_MCP_SOURCE_URL": "git@github.com:your-org/design-system.git",
        "DS_MCP_SOURCE_BRANCH": "main",
        "DS_MCP_REFRESH_INTERVAL_SEC": "300"
      }
    }
  }
}
```

---

## Streamable HTTP: hosted single instance

Use this when a small team shares one running instance.

The hosted server is started by the operator (see `docs/runbook.md`); IDEs only need its URL and an API key.

> **Note on IDE config schemas.** The JSON shapes shown below for common MCP clients
> reflect common configuration patterns at
> the time of writing, but each IDE owns its own MCP-config schema and may
> evolve it. Verify against the IDE's own MCP docs if a config is rejected,
> and fall back to the SDK example (`Custom agent (HTTP mode)` below) — that
> path uses the official MCP TypeScript SDK and is verified by this repo's
> `tests/integration/http-mode.test.ts`.

| Server-side variable | Value |
|---|---|
| `DS_MCP_MODE` | `http` |
| `DS_MCP_AUTH_MODE` | `apikey` |
| `DS_MCP_API_KEYS` | comma-separated SHA-256 hex digests of the API keys |
| `DS_MCP_ADMIN_TOKEN` | bearer token for `POST /admin/refresh` (optional) |

To produce a SHA-256 digest of an API key:

```bash
printf '%s' 'ds-mcp-team-key-1' | shasum -a 256
# → 0adc... 64-hex-chars ...e1
```

Put `0adc...e1` into `DS_MCP_API_KEYS`. Hand `ds-mcp-team-key-1` (the unhashed key) to clients.

### Generic HTTP MCP client

```json
{
  "mcpServers": {
    "design-system": {
      "url": "https://ds-mcp.your-org.example/mcp",
      "headers": {
        "Authorization": "Bearer ds-mcp-team-key-1"
      }
    }
  }
}
```

### Cursor (HTTP mode)

```json
{
  "mcpServers": {
    "design-system": {
      "url": "https://ds-mcp.your-org.example/mcp",
      "headers": {
        "Authorization": "Bearer ds-mcp-team-key-1"
      }
    }
  }
}
```

### Custom agent (HTTP mode)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://ds-mcp.your-org.example/mcp"),
  {
    requestInit: {
      headers: { Authorization: "Bearer ds-mcp-team-key-1" },
    },
  },
);

const client = new Client({ name: "my-agent", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);
```

---

## Verifying the connection

Once the client config lands and the IDE restarts, the design-system tools should appear in the agent's tool list. Quick smoke test in any chat:

> Use describe_schema to tell me what entity types are loaded.

Expected: a JSON-shaped response with `types`, `relations`, `totalEntities>0`, and a `bundleVersion` string of the form `<gitSha-or-"nogit">-<ISO-timestamp>`.

If `totalEntities` is `0` or the call returns a `bundle_unavailable` error, the server failed to load the source — check the server logs (stderr in stdio mode; the log sink in HTTP mode) for `git: update failed` (clone/pull failure) or `scheduled refresh failed` (build failure).

If the tools never appear:
- Confirm the binary path exists (`ls /abs/path/to/ds-mcp-server/dist/index.js`)
- Run the server manually: `DS_MCP_MODE=stdio DS_MCP_SOURCE_MODE=local DS_MCP_SOURCE_PATH=... node dist/index.js < /dev/null` — should not print anything to stdout, and should print structured JSON to stderr
- Check the IDE's MCP log for spawn errors

---

## Tool surface

Once connected, the agent has access to:

| Tool | Use case |
|---|---|
| `describe_schema` | Discover what content types exist before searching |
| `search_design_system` | Full-text search across the loaded bundle |
| `get_entity` | Fetch one entity by id (`token:color.action.primary`, `principle:clarity`, etc.) |
| `list_entities` | Browse the catalog filtered by type or tag |
| `get_related` | Walk one hop in the relation graph |
| `resolve_token` | Find tokens by partial name; format for `css`/`ios`/`android`/`react-native`/`raw` |
| `validate_ui` | Run the loaded validation rules against a snippet of generated code |
| `get_usage` | Canonical import path + props + examples + constraints for a component |
| `get_component_source` | Existing component implementation files for reuse instead of rewrite |
| `recommend_composition` | Implementation brief: components + tokens + principles for an intent |
| `validate_composition` | Check a candidate component composition against a pattern's contract |
| `validate_design_contract` | Structured handoff checks for contrast, charts, layout, package versions, platform mappings, visual baselines, and imported design-file coverage |
| `inspect_coverage` | Bundle-side diagnostics — what's missing or inconsistent |

Plus MCP **resources** (`design://manifest`, `design://schema`, `design://entity/{id}`, `design://principle/{id}`, `design://pattern/{id}`, `design://component/{id}`, `design://prompt/{name}`) and any **prompts** the source repo declares under `prompts/*.prompt.md`.

See the MCP Tools section in `README.md` for the public tool list and workflow guidance.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools never appear in IDE | Spawn failed | Run the binary manually with the same env to see the boot log on stderr |
| `bundle_unavailable` errors | Bundle never loaded | Server boot failed mid-build; check stderr for the parser/Style-Dictionary error |
| `unknown rule id` from `validate_ui` | Rule not in the bundle | The rule must exist in `<source>/rules/*.json`; either add it or omit `rules:` from the call |
| `unauthorized` on `/mcp` | Wrong API key, or `DS_MCP_AUTH_MODE` not set | Verify the key matches one of the SHA-256 hashes in `DS_MCP_API_KEYS` |
| Old content after a UX merge | Refresh interval hasn't elapsed | Trigger an immediate refresh: `curl -XPOST -H "Authorization: Bearer $DS_MCP_ADMIN_TOKEN" $URL/admin/refresh` |
| `/readyz` returns 503 | Bundle still loading or instance draining | Wait a few seconds for boot; if persistent, see runbook §"Server fails to start" |
