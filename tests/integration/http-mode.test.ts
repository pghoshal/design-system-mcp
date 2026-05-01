import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { LocalSourceAdapter } from "../../src/source/local.js";
import { SourceManager } from "../../src/source/manager.js";
import { type HttpTransportHandle, startHttp } from "../../src/transport/http.js";
import { LayeredCache } from "../../src/util/lru.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "design-systems", "sample");

const logger = pino({ level: "silent" });

const API_KEY = "test-key-12345";
const API_KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");
const ADMIN_TOKEN = "admin-secret-token";

let manager: SourceManager;
let cache: LayeredCache;
let handle: HttpTransportHandle;
let baseUrl: string;

beforeAll(async () => {
  cache = new LayeredCache();
  manager = new SourceManager({
    adapter: new LocalSourceAdapter(FIXTURE, logger),
    logger,
    refreshIntervalSec: 60,
  });
  await manager.initial();

  const cfg: Config = {
    DS_MCP_MODE: "http",
    DS_MCP_SOURCE_MODE: "local",
    DS_MCP_SOURCE_PATH: FIXTURE,
    DS_MCP_SOURCE_BRANCH: "main",
    DS_MCP_CACHE_DIR: "~/.cache/ds-mcp",
    DS_MCP_REFRESH_INTERVAL_SEC: 300,
    PORT: 0, // ephemeral
    LOG_LEVEL: "silent" as never,
    DS_MCP_AUTH_MODE: "apikey",
    DS_MCP_API_KEYS: API_KEY_HASH,
    DS_MCP_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  handle = (await startHttp(cfg, { source: manager, cache, logger })) as HttpTransportHandle;
  baseUrl = `http://127.0.0.1:${handle.port}`;
}, 30_000);

afterAll(async () => {
  await handle.stop();
  await manager.stop();
});

describe("Phase 2 — HTTP transport", () => {
  describe("health endpoints", () => {
    it("/healthz responds 200", async () => {
      const r = await fetch(`${baseUrl}/healthz`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: "ok" });
    });

    it("/readyz responds 200 with bundle info", async () => {
      const r = await fetch(`${baseUrl}/readyz`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; bundleVersion: string };
      expect(body.status).toBe("ok");
      expect(body.bundleVersion).toBeTruthy();
    });

    it("/version returns build + bundle info", async () => {
      const r = await fetch(`${baseUrl}/version`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.name).toBe("ds-mcp-server");
      expect(body.mode).toBe("http");
      expect(body.bundleLoaded).toBe(true);
    });
  });

  describe("auth", () => {
    it("rejects /mcp without Authorization", async () => {
      const r = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json,text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    });

    it("rejects /mcp with bad bearer", async () => {
      const r = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json,text/event-stream",
          Authorization: "Bearer wrong-key",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    });
  });

  describe("MCP via Streamable HTTP", () => {
    it("initialize + tools/list + tools/call round trip", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      });
      const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
      // SDK Transport interface uses optional fields incompatible with exactOptionalPropertyTypes.
      // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
      await client.connect(transport as any);

      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThanOrEqual(6);
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toContain("describe_schema");
      expect(names).toContain("search_design_system");
      expect(names).toContain("get_entity");
      expect(names).toContain("list_entities");
      expect(names).toContain("resolve_token");
      expect(names).toContain("get_related");
      expect(names).toContain("validate_ui");

      const result = await client.callTool({
        name: "describe_schema",
        arguments: {},
      });
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.totalEntities as number) ?? 0).toBeGreaterThan(20);

      const search = await client.callTool({
        name: "search_design_system",
        arguments: { query: "primary blue", type: "token", limit: 3 },
      });
      const ssc = search.structuredContent as { hits: Array<{ id: string }>; total: number };
      expect(ssc.total).toBeGreaterThan(0);
      expect(ssc.hits.some((h) => h.id === "token:color.action.primary")).toBe(true);

      const validation = await client.callTool({
        name: "validate_ui",
        arguments: { code: "const c = '#2563EB';", language: "tsx" },
      });
      const vsc = validation.structuredContent as {
        ok: boolean;
        violations: Array<{ ruleId: string; match?: string }>;
      };
      expect(vsc.ok).toBe(false);
      expect(vsc.violations.some((v) => v.ruleId === "no-hex-colors")).toBe(true);

      await client.close();
    }, 15_000);
  });

  describe("/admin/refresh", () => {
    it("rejects without token", async () => {
      const r = await fetch(`${baseUrl}/admin/refresh`, { method: "POST" });
      expect(r.status).toBe(401);
    });

    it("rejects with wrong token", async () => {
      const r = await fetch(`${baseUrl}/admin/refresh`, {
        method: "POST",
        headers: { Authorization: "Bearer not-the-admin-token" },
      });
      expect(r.status).toBe(401);
    });

    it("accepts with admin token", async () => {
      const r = await fetch(`${baseUrl}/admin/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(r.status).toBe(202);
      const body = (await r.json()) as { accepted: boolean; changed: boolean; version: string };
      expect(body.accepted).toBe(true);
      expect(typeof body.version).toBe("string");
    });
  });

  describe("drain", () => {
    it("/readyz returns 503 after beginDrain", async () => {
      handle.beginDrain();
      const r = await fetch(`${baseUrl}/readyz`);
      expect(r.status).toBe(503);
      const body = (await r.json()) as { status: string };
      expect(body.status).toBe("draining");
    });

    it("/healthz remains 200 during drain", async () => {
      const r = await fetch(`${baseUrl}/healthz`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: "ok" });
    });

    it("/admin/refresh returns 503 during drain", async () => {
      const r = await fetch(`${baseUrl}/admin/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "draining" });
    });
  });
});
