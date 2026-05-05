import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { ApiKeyValidator } from "../auth/apikey.js";
import type { Config } from "../config.js";
import { buildMcpServer } from "../server/mcp.js";
import type { ServerDeps, TransportHandle } from "../server/types.js";
import { WorkflowAuditStore } from "../server/workflow-audit.js";

export interface HttpTransportHandle extends TransportHandle {
  /** Force-refresh trigger for tests. Production callers go via POST /admin/refresh. */
  internalRefresh: () => Promise<{ changed: boolean; version: string }>;
  /** Bound port (useful in tests when listening on :0). */
  port: number;
}

export async function startHttp(cfg: Config, deps: ServerDeps): Promise<HttpTransportHandle> {
  const app: FastifyInstance = Fastify({ logger: false, disableRequestLogging: true });
  const serverDeps: ServerDeps = { ...deps, audit: deps.audit ?? new WorkflowAuditStore() };

  const validator =
    cfg.DS_MCP_AUTH_MODE === "apikey" ? new ApiKeyValidator(cfg.DS_MCP_API_KEYS ?? "") : null;

  let draining = false;

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    if (draining) {
      reply.code(503);
      return { status: "draining" };
    }
    if (!serverDeps.source.hasBundle()) {
      reply.code(503);
      return { status: "not_ready", bundleLoaded: false };
    }
    return { status: "ok", bundleLoaded: true, bundleVersion: serverDeps.source.current().version };
  });
  app.get("/version", async () => ({
    name: "ds-mcp-server",
    version: "0.0.1",
    mode: cfg.DS_MCP_MODE,
    sourceMode: cfg.DS_MCP_SOURCE_MODE,
    authMode: cfg.DS_MCP_AUTH_MODE,
    bundleLoaded: serverDeps.source.hasBundle(),
    bundleVersion: serverDeps.source.hasBundle() ? serverDeps.source.current().version : null,
  }));

  // -------- MCP endpoint (Streamable HTTP, stateless) --------
  // SDK pattern for stateless mode: build a fresh server + transport per request.
  // Tool registration is cheap; this avoids cross-request state interference and
  // matches the documented MCP SDK example.
  const handleMcp = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    body: unknown,
  ): Promise<void> => {
    const reqServer = buildMcpServer(serverDeps);
    const reqTransport = new StreamableHTTPServerTransport({
      // biome-ignore lint/suspicious/noExplicitAny: SDK option type vs exactOptionalPropertyTypes
      sessionIdGenerator: undefined as any,
    });
    reply.raw.on("close", () => {
      void reqTransport.close().catch(() => undefined);
      void reqServer.close().catch(() => undefined);
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK Transport interface uses optional callbacks
    await reqServer.connect(reqTransport as any);
    await reqTransport.handleRequest(req.raw, reply.raw, body);
  };

  app.post("/mcp", async (req, reply) => {
    if (draining) {
      reply.code(503);
      return { error: "draining" };
    }
    if (validator) {
      const presented = ApiKeyValidator.extractBearer(req.headers.authorization);
      if (!validator.validate(presented)) {
        reply.code(401);
        return { error: "unauthorized" };
      }
    }
    reply.hijack();
    await handleMcp(req, reply, req.body);
  });

  app.get("/mcp", async (req, reply) => {
    if (draining) {
      reply.code(503);
      return { error: "draining" };
    }
    if (validator) {
      const presented = ApiKeyValidator.extractBearer(req.headers.authorization);
      if (!validator.validate(presented)) {
        reply.code(401);
        return { error: "unauthorized" };
      }
    }
    reply.hijack();
    await handleMcp(req, reply, undefined);
  });

  app.delete("/mcp", async (req, reply) => {
    if (draining) {
      reply.code(503);
      return { error: "draining" };
    }
    if (validator) {
      const presented = ApiKeyValidator.extractBearer(req.headers.authorization);
      if (!validator.validate(presented)) {
        reply.code(401);
        return { error: "unauthorized" };
      }
    }
    reply.hijack();
    await handleMcp(req, reply, undefined);
  });

  // -------- Admin: force refresh --------
  app.post("/admin/refresh", async (req, reply) => {
    if (draining) {
      reply.code(503);
      return { error: "draining" };
    }
    const adminToken = cfg.DS_MCP_ADMIN_TOKEN;
    if (!adminToken) {
      reply.code(403);
      return { error: "admin endpoint disabled (no DS_MCP_ADMIN_TOKEN configured)" };
    }
    const presented = ApiKeyValidator.extractBearer(req.headers.authorization);
    if (presented !== adminToken) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const result = await deps.source.refresh();
    reply.code(202);
    return { accepted: true, ...result };
  });

  // -------- Listen --------
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.PORT;
  serverDeps.logger.info({ port, authMode: cfg.DS_MCP_AUTH_MODE }, "http transport listening");

  return {
    port,
    beginDrain: () => {
      draining = true;
      serverDeps.logger.info("http transport: drain initiated");
    },
    stop: async () => {
      await app.close();
      serverDeps.logger.info("http transport closed");
    },
    internalRefresh: () => serverDeps.source.refresh(),
  };
}
