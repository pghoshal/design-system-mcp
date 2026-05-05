import type { ZodTypeAny, z } from "zod";
import type { Logger } from "../observability/logger.js";
import type { SourceManager } from "../source/manager.js";
import type { LayeredCache } from "../util/lru.js";
import type { WorkflowAuditStore } from "./workflow-audit.js";

/**
 * Per-request context. Tools must use these accessors and not reach into globals.
 */
export interface RequestContext {
  source: SourceManager;
  cache: LayeredCache;
  logger: Logger;
  requestId: string;
  audit?: WorkflowAuditStore | undefined;
}

/**
 * Server-scoped dependencies passed into the MCP wiring. The transport layer
 * builds these once and supplies them to every tool invocation via RequestContext.
 */
export interface ServerDeps {
  source: SourceManager;
  cache: LayeredCache;
  logger: Logger;
  audit?: WorkflowAuditStore | undefined;
}

/**
 * Common shape returned by both transports. The HTTP transport extends this
 * with `port` and `internalRefresh` for tests.
 */
export interface TransportHandle {
  stop: () => Promise<void>;
  beginDrain: () => void;
}

export interface ToolHandler<I extends ZodTypeAny, O extends ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  handle: (args: z.infer<I>, ctx: RequestContext) => Promise<z.infer<O>>;
}
