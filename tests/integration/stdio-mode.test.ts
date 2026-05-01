import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "design-systems", "sample");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");

let stderrChunks: string[] = [];

async function newConnectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  // Whitelist only the env vars the spawned binary actually needs. Spreading
  // `process.env` would let the maintainer's local `DS_MCP_*` overrides leak
  // into the test and produce false greens locally with reds in CI.
  const childEnv: Record<string, string> = {
    DS_MCP_MODE: "stdio",
    DS_MCP_SOURCE_MODE: "local",
    DS_MCP_SOURCE_PATH: FIXTURE,
    LOG_LEVEL: "info",
    NODE_ENV: "test",
  };
  if (process.env.PATH) childEnv.PATH = process.env.PATH;
  if (process.env.HOME) childEnv.HOME = process.env.HOME;

  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [ENTRY],
    env: childEnv,
    stderr: "pipe",
  });
  // SDK exposes `transport.stderr` as a PassThrough available immediately,
  // before start() is invoked, exactly to let us attach listeners without
  // racing the child's boot-time output. (See @modelcontextprotocol/sdk/dist/
  // esm/client/stdio.js — `get stderr()` JSDoc.)
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const client = new Client({ name: "stdio-test", version: "0.0.1" }, { capabilities: {} });
  // biome-ignore lint/suspicious/noExplicitAny: SDK Transport optional fields vs exactOptionalPropertyTypes
  await client.connect(transport as any);

  return {
    client,
    // SDK's StdioClientTransport.close() ends stdin, waits 2s for natural exit,
    // then SIGTERM, then SIGKILL — see node_modules/@modelcontextprotocol/sdk/
    // dist/esm/client/stdio.js. So Client.close() (which delegates to
    // transport.close()) is sufficient to reap the child without leaking.
    close: async () => {
      await client.close();
    },
  };
}

let conn: { client: Client; close: () => Promise<void> };

beforeAll(async () => {
  // Fail loud and early if the test runner is missing tsx — the test would
  // otherwise hang on connect(), reported as a generic timeout.
  await fs.stat(TSX_BIN).catch(() => {
    throw new Error(
      `tsx binary not found at ${TSX_BIN}. Run \`pnpm install\` before invoking this test.`,
    );
  });

  stderrChunks = [];
  conn = await newConnectedClient();
}, 30_000);

afterAll(async () => {
  if (conn) await conn.close();
});

describe("Phase 4 — stdio transport", () => {
  it("emits structured logs to stderr immediately after boot (load-bearing for the no-stdout-pollution claim)", () => {
    // We assert at the very first test that stderr was populated by the
    // server's boot-time log lines. If logs ever regressed onto stdout,
    // (a) the SDK's stdio JSON-RPC parser would reject the non-JSON frames and
    // initialize would have thrown by now, AND (b) this assertion would fail.
    const combined = stderrChunks.join("");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).toContain('"msg":');
    expect(combined).toContain('"ds-mcp-server starting"');
  });

  it("initialize handshake exposes server info", () => {
    const info = conn.client.getServerVersion();
    expect(info?.name).toBe("ds-mcp-server");
    expect(info?.version).toBeTruthy();
  });

  it("tools/list returns the full tool surface", async () => {
    const list = await conn.client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    for (const expected of [
      "describe_schema",
      "search_design_system",
      "get_entity",
      "list_entities",
      "get_related",
      "resolve_token",
      "validate_ui",
      "get_usage",
      "recommend_composition",
      "validate_composition",
      "inspect_coverage",
      "explain_decision",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("tools/call describe_schema returns the loaded bundle's schema", async () => {
    const result = await conn.client.callTool({ name: "describe_schema", arguments: {} });
    const sc = result.structuredContent as {
      schemaVersion: string;
      bundleVersion: string;
      types: Record<string, unknown>;
      totalEntities: number;
    };
    expect(sc.schemaVersion).toBeTruthy();
    expect(sc.bundleVersion).toBeTruthy();
    expect(Object.keys(sc.types).length).toBeGreaterThan(0);
    expect(sc.totalEntities).toBeGreaterThan(0);
  });

  it("tools/call search_design_system finds the primary action token", async () => {
    const result = await conn.client.callTool({
      name: "search_design_system",
      arguments: { query: "primary blue", type: "token", limit: 3 },
    });
    const sc = result.structuredContent as { hits: Array<{ id: string }>; total: number };
    expect(sc.total).toBeGreaterThan(0);
    expect(sc.hits.some((h) => h.id === "token:color.action.primary")).toBe(true);
  });

  it("resources/list and resources/read work over stdio", async () => {
    const list = await conn.client.listResources();
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain("design://manifest");
    expect(uris).toContain("design://workflow");

    const read = await conn.client.readResource({ uri: "design://manifest" });
    const body = read.contents[0];
    const text = body && "text" in body ? (body.text as string) : "";
    const json = JSON.parse(text) as { totalEntities: number };
    expect(json.totalEntities).toBeGreaterThan(0);

    const workflow = await conn.client.readResource({ uri: "design://workflow" });
    const workflowBody = workflow.contents[0];
    const workflowText =
      workflowBody && "text" in workflowBody ? (workflowBody.text as string) : "";
    const workflowJson = JSON.parse(workflowText) as { finalGate: { requiredTools: string[] } };
    expect(workflowJson.finalGate.requiredTools).toContain("validate_composition");
  });

  it("prompts/list and prompts/get work over stdio", async () => {
    const list = await conn.client.listPrompts();
    expect(list.prompts.map((p) => p.name)).toContain("build_with_design_system");
    expect(list.prompts.map((p) => p.name)).toContain("repair_design_violations");

    const got = await conn.client.getPrompt({
      name: "build_with_design_system",
      arguments: { component_type: "delete confirmation", requirements: "" },
    });
    expect(got.messages.length).toBeGreaterThan(0);
    const first = got.messages[0];
    const text = first && first.content.type === "text" ? (first.content.text as string) : "";
    expect(text).toContain("delete confirmation");
  });
});
