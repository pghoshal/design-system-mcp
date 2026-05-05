import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ZodTypeAny, z } from "zod";
import { handler as describeSchemaHandler } from "../tools/describe-schema.js";
import { handler as explainDecisionHandler } from "../tools/explain-decision.js";
import { handler as getComponentSourceHandler } from "../tools/get-component-source.js";
import { handler as getEntityHandler } from "../tools/get-entity.js";
import { handler as getRelatedHandler } from "../tools/get-related.js";
import { handler as getUsageHandler } from "../tools/get-usage.js";
import { handler as inspectCoverageHandler } from "../tools/inspect-coverage.js";
import { handler as listEntitiesHandler } from "../tools/list-entities.js";
import { handler as recommendCompositionHandler } from "../tools/recommend-composition.js";
import { handler as resolveTokenHandler } from "../tools/resolve-token.js";
import { handler as searchHandler } from "../tools/search-design-system.js";
import { handler as startWorkflowHandler } from "../tools/start-workflow.js";
import { handler as validateCompositionHandler } from "../tools/validate-composition.js";
import { handler as validateDesignContractHandler } from "../tools/validate-design-contract.js";
import { handler as validateUiHandler } from "../tools/validate-ui.js";
import { ToolError } from "../util/errors.js";
import { newRequestId } from "../util/ids.js";
import { hashJson } from "../util/stable-hash.js";
import { registerPrompts, registerResources } from "./registrations.js";
import type { RequestContext, ServerDeps, ToolHandler } from "./types.js";
import { WorkflowAuditStore } from "./workflow-audit.js";

export interface BuildServerOptions extends ServerDeps {
  name?: string;
  version?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: tool handlers are heterogeneous; SDK widens at runtime
const TOOLS: ReadonlyArray<ToolHandler<any, any>> = [
  startWorkflowHandler,
  describeSchemaHandler,
  searchHandler,
  getEntityHandler,
  listEntitiesHandler,
  getRelatedHandler,
  resolveTokenHandler,
  validateUiHandler,
  getUsageHandler,
  getComponentSourceHandler,
  recommendCompositionHandler,
  validateCompositionHandler,
  validateDesignContractHandler,
  inspectCoverageHandler,
  explainDecisionHandler,
];

export function buildMcpServer(opts: BuildServerOptions): McpServer {
  const deps: ServerDeps = { ...opts, audit: opts.audit ?? new WorkflowAuditStore() };
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
    registerTool(server, tool, deps);
  }
  registerPrompts(server, deps);
  registerResources(server, deps);

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
      audit: deps.audit,
    };

    const start = Date.now();
    try {
      const result = await tool.handle(args, ctx);
      const resultHash = hashJson(result);
      const workflowSessionId = readWorkflowSessionId(args);
      if (workflowSessionId && deps.audit) {
        deps.audit.record(workflowSessionId, {
          tool: tool.name,
          bundleVersion: ctx.source.current().version,
          resultHash,
          input: args,
          output: result,
        });
      }
      const resultWithHash =
        result && typeof result === "object" && !Array.isArray(result)
          ? { ...result, resultHash }
          : result;
      childLogger.info({ durationMs: Date.now() - start, status: "ok" }, "tool ok");
      return {
        content: [{ type: "text", text: JSON.stringify(resultWithHash) }],
        structuredContent: resultWithHash as Record<string, unknown>,
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
      inputSchema:
        tool.input instanceof z.ZodObject
          ? tool.input.extend({ workflowSessionId: z.string().min(1).optional() })
          : tool.input,
    },
    // The SDK's callback type is a conditional that TS can't fully resolve
    // through our generic `I extends ZodTypeAny`. Runtime shape is correct.
    // biome-ignore lint/suspicious/noExplicitAny: SDK conditional type erasure
    callback as any,
  );
}

function readWorkflowSessionId(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).workflowSessionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
