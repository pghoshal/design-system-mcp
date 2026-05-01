import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../server/mcp.js";
import type { ServerDeps, TransportHandle } from "../server/types.js";

export async function startStdio(deps: ServerDeps): Promise<TransportHandle> {
  const server = buildMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  deps.logger.info("stdio transport ready");

  return {
    beginDrain: () => {
      // stdio has no upstream LB to signal; the caller will close shortly
    },
    stop: async () => {
      await server.close();
      deps.logger.info("stdio transport closed");
    },
  };
}
