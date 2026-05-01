import pino, { type Logger as PinoLogger } from "pino";
import type { Config } from "../config.js";

export type Logger = PinoLogger;

export function createLogger(cfg: Pick<Config, "LOG_LEVEL" | "DS_MCP_MODE">): Logger {
  // In stdio mode, MCP traffic uses stdout — logs MUST go to stderr only.
  const destination = cfg.DS_MCP_MODE === "stdio" ? pino.destination(2) : pino.destination(1);

  return pino(
    {
      level: cfg.LOG_LEVEL,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.apiKey",
          "*.secret",
          "*.token",
          "*.password",
          "*.privateKey",
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}
