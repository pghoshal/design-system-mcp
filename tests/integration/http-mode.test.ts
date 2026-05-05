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
      expect(names).toContain("get_usage");
      expect(names).toContain("get_component_source");
      expect(names).toContain("recommend_composition");
      expect(names).toContain("validate_composition");
      expect(names).toContain("validate_design_contract");
      expect(names).toContain("inspect_coverage");
      expect(names).toContain("explain_decision");
      expect(names).toContain("start_workflow");

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

      const usage = await client.callTool({
        name: "get_usage",
        arguments: { id: "component:button", language: "tsx" },
      });
      const usc = usage.structuredContent as {
        importPath?: string;
        examples: Array<{ code: string }>;
      };
      expect(usc.importPath).toBe("@acme/ui/button");
      expect(usc.examples.some((e) => e.code.includes("<Button"))).toBe(true);

      const coverage = await client.callTool({
        name: "inspect_coverage",
        arguments: { include_warnings: false },
      });
      const csc = coverage.structuredContent as { ok: boolean; issues: unknown[] };
      expect(csc.ok).toBe(true);
      expect(csc.issues).toEqual([]);

      await client.close();
    }, 15_000);

    it("validate_design_contract enforces server-side workflow audit sessions", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      });
      const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
      // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
      await client.connect(transport as any);

      const toolResults: Array<{
        tool: string;
        ok: boolean;
        bundleVersion: string;
        resultHash: string;
      }> = [];
      let bundleVersion = "";
      const call = async (tool: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: tool, arguments: args });
        const structured = result.structuredContent as {
          bundleVersion?: string;
          resultHash?: string;
        };
        if (structured.bundleVersion) bundleVersion = structured.bundleVersion;
        toolResults.push({
          tool,
          ok: !result.isError,
          bundleVersion: structured.bundleVersion ?? bundleVersion,
          resultHash: structured.resultHash ?? "sha256:missing",
        });
        return structured;
      };

      const start = (await call("start_workflow", {
        intent: "Build a confirmation action",
      })) as { workflowSessionId: string; bundleVersion: string };
      const workflowSessionId = start.workflowSessionId;
      bundleVersion = start.bundleVersion;
      const session = { workflowSessionId };

      await call("describe_schema", session);
      await call("search_design_system", { ...session, query: "button", limit: 3 });
      await call("list_entities", { ...session, type: "component", limit: 3 });
      await call("get_entity", { ...session, id: "component:button" });
      await call("get_related", { ...session, id: "component:button" });
      await call("inspect_coverage", { ...session, include_warnings: false });
      await call("recommend_composition", {
        ...session,
        intent: "Confirmation dialog with primary action",
        limit: 5,
      });
      await call("get_usage", {
        ...session,
        id: "component:button",
        platform: "web",
        framework: "react",
      });
      await call("get_component_source", {
        ...session,
        id: "component:button",
        includeStories: false,
      });
      await call("resolve_token", { ...session, query: "color.action.primary", limit: 1 });
      await call("validate_composition", {
        ...session,
        pattern: "pattern:confirmation-dialog",
        platform: "web",
        framework: "react",
        tokens: ["token:color.action.primary"],
        components: [
          {
            id: "component:button",
            props: { variant: "primary", children: "Save changes" },
          },
        ],
      });
      await call("validate_ui", {
        ...session,
        language: "tsx",
        code: "const color = 'var(--color-action-primary)';",
      });
      await call("explain_decision", { ...session, entityId: "component:button" });
      await call("explain_decision", { ...session, entityId: "token:color.action.primary" });

      const contract = await client.callTool({
        name: "validate_design_contract",
        arguments: {
          workflowSessionId,
          workflowEvidence: {
            workflowSessionId,
            requiredToolsUsed: [
              "start_workflow",
              "describe_schema",
              "search_design_system",
              "list_entities",
              "get_entity",
              "get_related",
              "inspect_coverage",
              "recommend_composition",
              "get_usage",
              "get_component_source",
              "resolve_token",
              "validate_composition",
              "validate_ui",
              "validate_design_contract",
              "explain_decision",
            ],
            toolResults: [
              ...toolResults,
              {
                tool: "validate_design_contract",
                ok: true,
                bundleVersion,
                resultHash: "sha256:current-call",
              },
            ],
            resourcesRead: ["design://workflow"],
            coverageProfile: "enterprise",
            coverageInspected: true,
          },
          componentSourceEvidence: {
            mode: "imported",
            targetPlatform: "web",
            targetFramework: "react",
            components: [
              {
                id: "component:button",
                sourceChecked: true,
                usageChecked: true,
                sourceFiles: ["components/Button/component.json"],
                imported: true,
                package: "@acme/react-ui",
                importPath: "@acme/react-ui/button",
              },
            ],
          },
          tokenResolutionEvidence: {
            resolvedTokens: [{ id: "token:color.action.primary" }],
            cssVariables: ["--color-action-primary"],
          },
          decisionEvidence: {
            explainedEntities: ["component:button", "token:color.action.primary"],
          },
        },
      });
      const structured = contract.structuredContent as {
        ok: boolean;
        violations: Array<{ ruleId: string }>;
      };
      expect(structured.ok).toBe(true);
      expect(structured.violations).toEqual([]);

      await client.close();
    }, 15_000);

    it("prompts/list + prompts/get return loaded design-system prompts", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      });
      const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
      // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
      await client.connect(transport as any);

      const list = await client.listPrompts();
      const names = list.prompts.map((p) => p.name);
      expect(names).toContain("build_with_design_system");
      expect(names).toContain("review_ui_against_design_system");
      expect(names).toContain("repair_design_violations");
      expect(names).toContain("choose_component");
      expect(names).toContain("migrate_to_design_system");

      const got = await client.getPrompt({
        name: "build_with_design_system",
        arguments: { component_type: "settings page", requirements: "tabs on the left" },
      });
      expect(got.messages.length).toBeGreaterThan(0);
      const firstMsg = got.messages[0];
      const text =
        firstMsg && firstMsg.content.type === "text" ? (firstMsg.content.text as string) : "";
      expect(text).toContain("settings page");
      expect(text).toContain("tabs on the left");

      await client.close();
    }, 15_000);

    it("rejects prompts/list and resources/list without Authorization", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
      // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
      await expect(client.connect(transport as any)).rejects.toThrow();
    }, 15_000);

    it("resources/list + resources/read expose manifest, schema, and entities", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      });
      const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
      // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
      await client.connect(transport as any);

      const list = await client.listResources();
      const uris = list.resources.map((r) => r.uri);
      expect(uris).toContain("design://manifest");
      expect(uris).toContain("design://schema");
      expect(uris).toContain("design://workflow");

      const manifest = await client.readResource({ uri: "design://manifest" });
      expect(manifest.contents.length).toBeGreaterThan(0);
      const manifestBody = manifest.contents[0];
      expect(manifestBody?.mimeType).toBe("application/json");
      const manifestText =
        manifestBody && "text" in manifestBody ? (manifestBody.text as string) : "";
      const manifestJson = JSON.parse(manifestText) as {
        types: Record<string, unknown>;
      };
      expect(Object.keys(manifestJson.types).length).toBeGreaterThan(0);

      const schema = await client.readResource({ uri: "design://schema" });
      expect(schema.contents[0]?.mimeType).toBe("application/json");

      const workflow = await client.readResource({ uri: "design://workflow" });
      const workflowText =
        workflow.contents[0] && "text" in workflow.contents[0]
          ? (workflow.contents[0].text as string)
          : "";
      const workflowJson = JSON.parse(workflowText) as {
        mode: string;
        modes: Array<{ name: string; requiredEvidence: string[] }>;
        stateMachine: Array<{ from: string; to: string }>;
        requiredSequence: string[];
        finalGate: {
          mode: string;
          requiredTools: string[];
          requiredEvidence: string[];
          cli: string;
          requiredOutcome: string;
        };
      };
      expect(workflowJson.mode).toBe("design-system-first");
      expect(workflowJson.modes).toContainEqual(
        expect.objectContaining({
          name: "final_check",
          requiredEvidence: [
            "workflowEvidence",
            "componentSourceEvidence",
            "tokenResolutionEvidence",
            "decisionEvidence",
            "validate_composition",
            "validate_ui",
            "validate_design_contract",
          ],
        }),
      );
      expect(workflowJson.stateMachine).toContainEqual({ from: "validate", to: "final_check" });
      expect(workflowJson.requiredSequence).toContain("recommend_composition");
      expect(workflowJson.requiredSequence).toContain("inspect_coverage");
      expect(workflowJson.requiredSequence).toContain("get_component_source");
      expect(workflowJson.requiredSequence).toContain("resolve_token");
      expect(workflowJson.requiredSequence).toContain("validate_design_contract");
      expect(workflowJson.finalGate.mode).toBe("final_check");
      expect(workflowJson.finalGate.requiredTools).toContain("validate_ui");
      expect(workflowJson.finalGate.requiredTools).toContain("get_component_source");
      expect(workflowJson.finalGate.requiredEvidence).toEqual([
        "workflowEvidence",
        "componentSourceEvidence",
        "tokenResolutionEvidence",
        "decisionEvidence",
        "validate_composition",
        "validate_ui",
        "validate_design_contract",
      ]);
      expect(workflowJson.finalGate.cli).toContain("--mode final_check");
      expect(workflowJson.finalGate.cli).toContain("--contract");
      expect(workflowJson.finalGate.requiredOutcome).toContain("no missing workflow");

      const entity = await client.readResource({ uri: "design://entity/principle:clarity" });
      const body = entity.contents[0];
      expect(body?.mimeType).toBe("application/json");
      const entityText = body && "text" in body ? (body.text as string) : "";
      const entityJson = JSON.parse(entityText) as {
        id: string;
        type: string;
        summary: string;
      };
      expect(entityJson.id).toBe("principle:clarity");
      expect(entityJson.type).toBe("principle");

      // Per-type templated resources are listed and resolve.
      const principleUri = "design://principle/principle:clarity";
      expect(uris).toContain(principleUri);
      const principleRead = await client.readResource({ uri: principleUri });
      const principleBody = principleRead.contents[0];
      expect(principleBody?.mimeType).toBe("application/json");

      const promptUri = "design://prompt/build_with_design_system";
      expect(uris).toContain(promptUri);
      const promptRead = await client.readResource({ uri: promptUri });
      const promptBody = promptRead.contents[0];
      const promptText = promptBody && "text" in promptBody ? (promptBody.text as string) : "";
      const promptJson = JSON.parse(promptText) as { name: string; body: string };
      expect(promptJson.name).toBe("build_with_design_system");
      expect(promptJson.body.length).toBeGreaterThan(0);

      // Reading an unknown entity surfaces an error to the client.
      await expect(
        client.readResource({ uri: "design://entity/token:does-not-exist" }),
      ).rejects.toThrow();

      // Reading the wrong type rejects with a clear message.
      await expect(
        client.readResource({ uri: "design://principle/token:color.action.primary" }),
      ).rejects.toThrow();

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
