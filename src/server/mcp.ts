import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";
import { handler as describeSchemaHandler } from "../tools/describe-schema.js";
import { handler as explainDecisionHandler } from "../tools/explain-decision.js";
import { handler as getEntityHandler } from "../tools/get-entity.js";
import { handler as getRelatedHandler } from "../tools/get-related.js";
import { handler as getUsageHandler } from "../tools/get-usage.js";
import { handler as inspectCoverageHandler } from "../tools/inspect-coverage.js";
import { handler as listEntitiesHandler } from "../tools/list-entities.js";
import { handler as recommendCompositionHandler } from "../tools/recommend-composition.js";
import { handler as resolveTokenHandler } from "../tools/resolve-token.js";
import { handler as searchHandler } from "../tools/search-design-system.js";
import { handler as validateCompositionHandler } from "../tools/validate-composition.js";
import { handler as validateUiHandler } from "../tools/validate-ui.js";
import { ToolError } from "../util/errors.js";
import { newRequestId } from "../util/ids.js";
import { registerPrompts, registerResources } from "./registrations.js";
import type { RequestContext, ServerDeps, ToolHandler } from "./types.js";

export interface BuildServerOptions extends ServerDeps {
  name?: string;
  version?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: tool handlers are heterogeneous; SDK widens at runtime
const TOOLS: ReadonlyArray<ToolHandler<any, any>> = [
  describeSchemaHandler,
  searchHandler,
  getEntityHandler,
  listEntitiesHandler,
  getRelatedHandler,
  resolveTokenHandler,
  validateUiHandler,
  getUsageHandler,
  recommendCompositionHandler,
  validateCompositionHandler,
  inspectCoverageHandler,
  explainDecisionHandler,
];

export function buildMcpServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer(
    {
      name: opts.name ?? "ds-mcp-server",
      version: opts.version ?? "0.0.1",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  for (const tool of TOOLS) {
    registerTool(server, tool, opts);
  }
  registerPrompts(server, opts);
  registerResources(server, opts);

  return server;
}

function registerTool<I extends ZodTypeAny, O extends ZodTypeAny>(
  server: McpServer,
  tool: ToolHandler<I, O>,
  deps: ServerDeps,
): void {
  const callback = async (args: unknown): Promise<CallToolResult> => {
    const requestId = newRequestId();
    const childLogger = deps.logger.child({ tool: tool.name, requestId });
    const ctx: RequestContext = {
      requestId,
      logger: childLogger,
      source: deps.source,
      cache: deps.cache,
    };

    const start = Date.now();
    try {
      const result = await tool.handle(args, ctx);
      childLogger.info({ durationMs: Date.now() - start, status: "ok" }, "tool ok");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      const code = err instanceof ToolError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      childLogger.error(
        { durationMs: Date.now() - start, status: "error", code, err: message },
        "tool error",
      );
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ code, message, requestId }) }],
      };
    }
  };

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
    },
    // The SDK's callback type is a conditional that TS can't fully resolve
    // through our generic `I extends ZodTypeAny`. Runtime shape is correct.
    // biome-ignore lint/suspicious/noExplicitAny: SDK conditional type erasure
    callback as any,
  );
}
