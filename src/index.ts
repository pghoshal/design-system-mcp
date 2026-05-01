import os from "node:os";
import path from "node:path";
import { type Config, loadConfig } from "./config.js";
import { type Logger, createLogger } from "./observability/logger.js";
import type { ServerDeps } from "./server/types.js";
import type { TransportHandle } from "./server/types.js";
import { GitSourceAdapter } from "./source/git.js";
import { LocalSourceAdapter } from "./source/local.js";
import { type SourceAdapter, SourceManager } from "./source/manager.js";
import { startHttp } from "./transport/http.js";
import { startStdio } from "./transport/stdio.js";
import { LayeredCache } from "./util/lru.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);

  logger.info(
    {
      mode: cfg.DS_MCP_MODE,
      sourceMode: cfg.DS_MCP_SOURCE_MODE,
      logLevel: cfg.LOG_LEVEL,
    },
    "ds-mcp-server starting",
  );

  const adapter = buildSourceAdapter(cfg, logger);
  const sourceManager = new SourceManager({
    adapter,
    logger,
    refreshIntervalSec: cfg.DS_MCP_REFRESH_INTERVAL_SEC,
  });
  const cache = new LayeredCache();

  await sourceManager.initial();
  sourceManager.startRefreshLoop();

  const deps: ServerDeps = { logger, source: sourceManager, cache };

  const handle: TransportHandle =
    cfg.DS_MCP_MODE === "stdio" ? await startStdio(deps) : await startHttp(cfg, deps);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown signal received");
    try {
      handle.beginDrain();
      // Give in-flight requests a brief window to complete before tearing down.
      await new Promise((r) => setTimeout(r, 250));
      await handle.stop();
      await sourceManager.stop();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "shutdown error");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason: String(reason) }, "unhandledRejection");
    process.exit(1);
  });
}

function buildSourceAdapter(cfg: Config, logger: Logger): SourceAdapter {
  if (cfg.DS_MCP_SOURCE_MODE === "local") {
    if (!cfg.DS_MCP_SOURCE_PATH) throw new Error("DS_MCP_SOURCE_PATH is required for local mode");
    return new LocalSourceAdapter(path.resolve(expandTilde(cfg.DS_MCP_SOURCE_PATH)), logger);
  }
  if (!cfg.DS_MCP_SOURCE_URL) throw new Error("DS_MCP_SOURCE_URL is required for git mode");
  return new GitSourceAdapter({
    url: cfg.DS_MCP_SOURCE_URL,
    branch: cfg.DS_MCP_SOURCE_BRANCH,
    cacheDir: expandTilde(cfg.DS_MCP_CACHE_DIR),
    authToken: cfg.GIT_AUTH_TOKEN,
    logger,
  });
}

function expandTilde(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
