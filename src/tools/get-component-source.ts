import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";

const SourceFileSchema = z.object({
  path: z.string(),
  language: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  content: z.string(),
});

export const GetComponentSourceInput = z.object({
  id: z.string().min(1).max(256),
  includeStories: z.boolean().default(true),
  includeTests: z.boolean().default(false),
  maxBytesPerFile: z.number().int().min(512).max(100_000).default(30_000),
  maxFiles: z.number().int().min(1).max(200).default(50),
  maxTotalBytes: z.number().int().min(512).max(1_000_000).default(200_000),
});

export const GetComponentSourceOutput = z.object({
  id: z.string(),
  sourcePath: z.string(),
  files: z.array(SourceFileSchema),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  bundleVersion: z.string(),
});

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".svelte",
  ".swift",
  ".kt",
  ".java",
  ".dart",
  ".css",
  ".scss",
  ".sass",
]);

export const handler: ToolHandler<typeof GetComponentSourceInput, typeof GetComponentSourceOutput> =
  {
    name: "get_component_source",
    description:
      "Return existing component implementation files from the design-system source repo. Use this when a component already exists so agents compose or import it instead of rewriting it.",
    input: GetComponentSourceInput,
    output: GetComponentSourceOutput,
    async handle(args, ctx) {
      const input = GetComponentSourceInput.parse(args);
      const bundle = ctx.source.current();
      const entity = bundle.entities.get(input.id);
      if (!entity || entity.type !== "component") {
        throw new ToolError("not_found", `unknown component id: ${input.id}`);
      }

      const sourceFile = path.join(bundle.sourcePath, entity.source.path);
      const componentDir = path.dirname(sourceFile);
      const files = await readComponentFiles(componentDir, bundle.sourcePath, input);
      return {
        id: entity.id,
        sourcePath: entity.source.path,
        files: files.files,
        totalBytes: files.totalBytes,
        truncated: files.truncated,
        bundleVersion: bundle.version,
      };
    },
  };

async function readComponentFiles(
  componentDir: string,
  repoRoot: string,
  args: z.infer<typeof GetComponentSourceInput>,
): Promise<{
  files: z.infer<typeof SourceFileSchema>[];
  totalBytes: number;
  truncated: boolean;
}> {
  const out: z.infer<typeof SourceFileSchema>[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const file of await walk(componentDir)) {
    if (out.length >= args.maxFiles) {
      truncated = true;
      break;
    }
    const ext = path.extname(file);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const base = path.basename(file).toLowerCase();
    if (!args.includeStories && base.includes(".stories.")) continue;
    if (!args.includeTests && /\.(test|spec)\./.test(base)) continue;
    const stat = await fs.stat(file);
    const remainingTotal = Math.max(0, args.maxTotalBytes - totalBytes);
    if (remainingTotal === 0) {
      truncated = true;
      break;
    }
    const bytesToRead = Math.min(stat.size, args.maxBytesPerFile, remainingTotal);
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, 0);
      totalBytes += bytesToRead;
      const fileTruncated = stat.size > bytesToRead;
      if (fileTruncated) truncated = true;
      out.push({
        path: path.relative(repoRoot, file),
        language: languageForExtension(ext),
        bytes: stat.size,
        truncated: fileTruncated,
        content: buffer.toString("utf8"),
      });
    } finally {
      await handle.close();
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, totalBytes, truncated };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function languageForExtension(ext: string): string {
  switch (ext) {
    case ".tsx":
      return "tsx";
    case ".ts":
      return "ts";
    case ".jsx":
      return "jsx";
    case ".js":
      return "js";
    case ".vue":
      return "vue";
    case ".svelte":
      return "svelte";
    case ".swift":
      return "swift";
    case ".kt":
      return "kotlin";
    case ".java":
      return "java";
    case ".dart":
      return "dart";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".sass":
      return "sass";
    default:
      return ext.replace(/^\./, "");
  }
}
