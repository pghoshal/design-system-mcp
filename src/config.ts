import { z } from "zod";

export const ConfigSchema = z
  .object({
    DS_MCP_MODE: z.enum(["stdio", "http"]).default("http"),
    DS_MCP_SOURCE_MODE: z.enum(["git", "local"]).default("git"),
    DS_MCP_SOURCE_URL: z.string().url().optional(),
    DS_MCP_SOURCE_BRANCH: z.string().default("main"),
    DS_MCP_SOURCE_PATH: z.string().optional(),
    DS_MCP_CACHE_DIR: z.string().default("~/.cache/ds-mcp"),
    DS_MCP_REFRESH_INTERVAL_SEC: z.coerce.number().int().min(30).default(300),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    DS_MCP_AUTH_MODE: z.enum(["none", "apikey"]).default("none"),
    DS_MCP_API_KEYS: z.string().optional(),
    DS_MCP_ADMIN_TOKEN: z.string().optional(),
    GIT_AUTH_TOKEN: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.DS_MCP_SOURCE_MODE === "git" && !cfg.DS_MCP_SOURCE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DS_MCP_SOURCE_URL"],
        message: "DS_MCP_SOURCE_URL is required when DS_MCP_SOURCE_MODE=git",
      });
    }
    if (cfg.DS_MCP_SOURCE_MODE === "local" && !cfg.DS_MCP_SOURCE_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DS_MCP_SOURCE_PATH"],
        message: "DS_MCP_SOURCE_PATH is required when DS_MCP_SOURCE_MODE=local",
      });
    }
    if (cfg.DS_MCP_AUTH_MODE === "apikey" && !cfg.DS_MCP_API_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DS_MCP_API_KEYS"],
        message: "DS_MCP_API_KEYS is required when DS_MCP_AUTH_MODE=apikey",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    process.stderr.write(
      `Invalid configuration:\n${JSON.stringify(parsed.error.format(), null, 2)}\n`,
    );
    process.exit(1);
  }
  return parsed.data;
}
