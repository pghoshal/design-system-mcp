import { z } from "zod";
import type { ToolHandler } from "../server/types.js";
import { cssTokenVar } from "../util/css-token-name.js";

export const ResolveTokenInput = z.object({
  query: z.string().min(1).max(256),
  platform: z.enum(["raw", "css", "ios", "android", "react-native", "flutter"]).default("raw"),
  limit: z.number().int().min(1).max(50).default(10),
});

const MatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.array(z.string()),
  value: z.string(),
  rawValue: z.string(),
  $type: z.string().optional(),
});

export const ResolveTokenOutput = z.object({
  matches: z.array(MatchSchema),
  bundleVersion: z.string(),
});

export const handler: ToolHandler<typeof ResolveTokenInput, typeof ResolveTokenOutput> = {
  name: "resolve_token",
  description:
    "Find design tokens by name or partial path (e.g. 'primary blue', 'spacing.md', 'color.primary.500'). Returns matches with values formatted for the requested platform. Use this whenever you need a concrete token value before generating UI code.",
  input: ResolveTokenInput,
  output: ResolveTokenOutput,
  async handle(args, ctx) {
    const bundle = ctx.source.current();
    const q = args.query.toLowerCase();
    const queryTerms = q.split(/[\s.]+/).filter(Boolean);

    const candidates: Array<{ score: number; entity: import("../bundle/types.js").Entity }> = [];
    for (const ent of bundle.entities.values()) {
      if (ent.type !== "token") continue;
      const haystack = `${ent.id} ${ent.summary} ${ent.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (haystack.includes(term)) score += 1;
        if (ent.id.toLowerCase().includes(term)) score += 1;
      }
      if (score > 0) candidates.push({ score, entity: ent });
    }
    candidates.sort((a, b) => b.score - a.score);

    const matches = candidates.slice(0, args.limit).map(({ entity }) => {
      const data = entity.data;
      const pathArr = (data.path as string[] | undefined) ?? [];
      const name = (data.name as string | undefined) ?? pathArr.join(".");
      const rawValueRaw = data.value;
      const rawValue = stringifyValue(rawValueRaw);
      const value = formatForPlatform(name, pathArr, rawValue, args.platform);
      const $type = (data.$type as string | undefined) ?? undefined;
      return {
        id: entity.id,
        name,
        path: pathArr,
        value,
        rawValue,
        ...($type !== undefined && { $type }),
      };
    });

    return { matches, bundleVersion: bundle.version };
  },
};

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function formatForPlatform(
  _name: string,
  pathArr: string[],
  rawValue: string,
  platform: "raw" | "css" | "ios" | "android" | "react-native" | "flutter",
): string {
  switch (platform) {
    case "raw":
      return rawValue;
    case "css":
      return `var(${cssTokenVar(pathArr)})`;
    case "ios":
      return `Tokens.${pathArr.join(".")}`;
    case "android":
      return `@${pathArr.join("_")}`;
    case "react-native":
      return `tokens.${pathArr.join(".")}`;
    case "flutter":
      return `AtlasTokens.${pathArr.map(toDartIdentifierPart).join(".")}`;
  }
}

function toDartIdentifierPart(part: string): string {
  return part
    .replace(/[^A-Za-z0-9_]+(.)?/g, (_match, next: string | undefined) =>
      next ? next.toUpperCase() : "",
    )
    .replace(/^[0-9]/, "_$&");
}
