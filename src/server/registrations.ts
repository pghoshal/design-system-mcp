import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ZodTypeAny, z } from "zod";
import type { Entity, PromptTemplate } from "../bundle/types.js";
import type { ServerDeps } from "./types.js";

const WORKFLOW_CONTRACT = {
  mode: "design-system-first",
  purpose:
    "Deterministic UX-to-dev handoff contract for agents and harnesses using this design-system MCP server.",
  modes: [
    {
      name: "plan_only",
      requiredEvidence: ["validate_composition"],
      exitCriteria: "Composition plan has no error-severity violations before code generation.",
    },
    {
      name: "generate",
      requiredEvidence: ["validate_composition"],
      exitCriteria: "Code generation is based on a validated component/pattern plan.",
    },
    {
      name: "validate",
      requiredEvidence: ["validate_composition", "validate_ui"],
      exitCriteria: "Generated code and composition plan have been validated.",
    },
    {
      name: "repair",
      requiredEvidence: ["validate_composition", "validate_ui"],
      exitCriteria: "All error-severity violations have deterministic repairs or are resolved.",
    },
    {
      name: "final_check",
      requiredEvidence: ["validate_composition", "validate_ui", "validate_design_contract"],
      exitCriteria: "No error-severity violations and no missing harness evidence remain.",
    },
  ],
  stateMachine: [
    { from: "plan_only", to: "generate" },
    { from: "generate", to: "validate" },
    { from: "validate", to: "repair" },
    { from: "repair", to: "validate" },
    { from: "validate", to: "final_check" },
  ],
  requiredSequence: [
    "describe_schema",
    "search_design_system",
    "recommend_composition",
    "get_usage",
    "get_component_source",
    "validate_composition",
    "validate_ui",
    "validate_design_contract",
    "explain_decision",
  ],
  finalGate: {
    mode: "final_check",
    requiredTools: ["validate_composition", "validate_ui", "validate_design_contract"],
    requiredEvidence: ["validate_composition", "validate_ui", "validate_design_contract"],
    cli: "pnpm validate -- --source <design-system-repo> --mode final_check --composition composition.json --contract handoff.json <file...>",
    requiredOutcome:
      "No error-severity violations and no missing required evidence may remain before generated UI is accepted.",
  },
  harnessPolicy: {
    enforceableByServer: false,
    enforceableByCli: true,
    serverGuarantee:
      "The server publishes this contract and deterministic evidence; MCP clients or CI harnesses must enforce blocking behavior.",
  },
  ci: {
    code: "pnpm validate -- --source <design-system-repo> --format sarif <file...>",
    composition: "pnpm validate -- --source <design-system-repo> --composition composition.json",
    contract: "pnpm validate -- --source <design-system-repo> --contract handoff.json",
  },
} as const;

/**
 * Register MCP prompts loaded from the source repo's `prompts/*.prompt.md`.
 * Each prompt's `arguments` are turned into a Zod raw shape; placeholders of
 * the form `{{ name }}` in the prompt body are substituted with the supplied
 * argument value (missing optional args become empty string).
 */
export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  let prompts: ReadonlyArray<PromptTemplate>;
  try {
    prompts = deps.source.current().prompts;
  } catch {
    // Bundle not loaded yet — register nothing; clients see an empty prompts list.
    return;
  }

  for (const prompt of prompts) {
    const argsSchema = buildPromptArgsSchema(prompt.arguments);
    server.registerPrompt(
      prompt.name,
      {
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
        argsSchema,
      },
      async (args: Record<string, string | undefined>) => {
        const body = substitutePlaceholders(prompt.body, args ?? {});
        return {
          messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }],
        };
      },
    );
  }
}

function buildPromptArgsSchema(args: PromptTemplate["arguments"]): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const a of args) {
    const base = z.string();
    shape[a.name] = a.required ? base : base.optional();
  }
  return shape;
}

function substitutePlaceholders(body: string, args: Record<string, string | undefined>): string {
  return body.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (_match, key: string) => {
    const value = args[key];
    return value ?? "";
  });
}

/**
 * Per-type entity resource templates. Each one filters the entity map to a
 * specific `Entity.type`, so e.g. `design://principle/{id}` will reject a token
 * id with a clear error instead of silently returning the wrong shape.
 */
const PER_TYPE_RESOURCES: ReadonlyArray<{
  resourceName: string;
  entityType: string;
  templatePattern: string;
  uriPrefix: string;
  title: string;
  description: string;
}> = [
  {
    resourceName: "principle",
    entityType: "principle",
    templatePattern: "design://principle/{id}",
    uriPrefix: "design://principle/",
    title: "Design system principle",
    description: "Fetch a principle entity (e.g. principle:clarity).",
  },
  {
    resourceName: "pattern",
    entityType: "pattern",
    templatePattern: "design://pattern/{id}",
    uriPrefix: "design://pattern/",
    title: "Design system pattern",
    description: "Fetch a pattern entity (e.g. pattern:confirmation-dialog).",
  },
  {
    resourceName: "component",
    entityType: "component",
    templatePattern: "design://component/{id}",
    uriPrefix: "design://component/",
    title: "Design system component",
    description: "Fetch a component entity by id (e.g. component:button).",
  },
];

/**
 * Register MCP resources for the design system:
 *   - `design://manifest`           (static)   — schema + counts + build metadata
 *   - `design://schema`             (static)   — schema declaration only
 *   - `design://workflow`           (static)   — machine-readable handoff contract
 *   - `design://entity/{id}`        (template) — any entity by id
 *   - `design://principle/{id}`     (template) — principle entities only
 *   - `design://pattern/{id}`       (template) — pattern entities only
 *   - `design://component/{id}`     (template) — component entities only
 *   - `design://prompt/{name}`      (template) — loaded prompt template body
 *
 * The list callback enumerates entities by id so MCP clients can discover them.
 * Resource resolution always re-reads the current bundle so a hot-rebuild is
 * reflected on the next read.
 *
 * Note: the `manifest` resource overlaps with the `describe_schema` tool. Both
 * are intentional: the resource is for client-side browsing/caching keyed by
 * URI, the tool is the agent-facing introspection call. Manifest carries extra
 * build metadata (version, builtAt, gitSha, prompts list) that `describe_schema`
 * does not need to surface.
 */
export function registerResources(server: McpServer, deps: ServerDeps): void {
  // Probe the bundle once at registration so failures surface during boot
  // rather than at the first client request.
  try {
    deps.source.current();
  } catch {
    return;
  }

  server.registerResource(
    "manifest",
    "design://manifest",
    {
      title: "Design system manifest",
      description: "Schema declaration + summary counts for the current bundle.",
      mimeType: "application/json",
    },
    async (uri) => {
      const b = deps.source.current();
      const payload = {
        version: b.version,
        schemaVersion: b.schemaVersion,
        builtAt: b.builtAt,
        gitSha: b.gitSha ?? null,
        types: b.schema.types,
        relations: b.schema.relations,
        totalEntities: b.entities.size,
        prompts: b.prompts.map((p) => p.name),
      };
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "schema",
    "design://schema",
    {
      title: "Design system schema",
      description: "Type definitions and relations declared in the source manifest.",
      mimeType: "application/json",
    },
    async (uri) => {
      const b = deps.source.current();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(b.schema, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "workflow",
    "design://workflow",
    {
      title: "Design-system workflow contract",
      description:
        "Machine-readable UX-to-dev handoff sequence and CI gates for design-consistent generation.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(WORKFLOW_CONTRACT, null, 2),
        },
      ],
    }),
  );

  registerEntityResource(server, deps);

  for (const def of PER_TYPE_RESOURCES) {
    registerPerTypeEntityResource(server, deps, def);
  }

  registerPromptResource(server, deps);
}

function registerEntityResource(server: McpServer, deps: ServerDeps): void {
  const template = new ResourceTemplate("design://entity/{id}", {
    list: async () => {
      const b = deps.source.current();
      const resources = [...b.entities.values()].map((ent) => entityResourceDescriptor(ent));
      return { resources };
    },
    // First-pass completion: substring match on entity id, capped at 50.
    // Sufficient for current corpus sizes; revisit if MCP clients ask for fuzzy/ranked completion.
    complete: {
      id: async (value: string) => {
        const b = deps.source.current();
        const ids: string[] = [];
        for (const id of b.entities.keys()) {
          if (id.includes(value)) ids.push(id);
          if (ids.length >= 50) break;
        }
        return ids;
      },
    },
  });

  server.registerResource(
    "entity",
    template,
    {
      title: "Design system entity",
      description:
        "Fetch a single entity by id. Use list_entities or search_design_system to discover ids.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = readVariable(variables.id);
      const b = deps.source.current();
      const entity = b.entities.get(id);
      if (!entity) throw new Error(`unknown entity: ${id}`);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(entity, null, 2),
          },
        ],
      };
    },
  );
}

function registerPerTypeEntityResource(
  server: McpServer,
  deps: ServerDeps,
  def: {
    resourceName: string;
    entityType: string;
    templatePattern: string;
    uriPrefix: string;
    title: string;
    description: string;
  },
): void {
  const template = new ResourceTemplate(def.templatePattern, {
    list: async () => {
      const b = deps.source.current();
      const resources: Array<{
        uri: string;
        name: string;
        description: string;
        mimeType: string;
      }> = [];
      for (const ent of b.entities.values()) {
        if (ent.type !== def.entityType) continue;
        resources.push({
          uri: `${def.uriPrefix}${ent.id}`,
          name: ent.id,
          description: ent.summary,
          mimeType: "application/json",
        });
      }
      return { resources };
    },
  });

  server.registerResource(
    def.resourceName,
    template,
    {
      title: def.title,
      description: def.description,
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = readVariable(variables.id);
      const b = deps.source.current();
      const entity = b.entities.get(id);
      if (!entity) throw new Error(`unknown ${def.entityType}: ${id}`);
      if (entity.type !== def.entityType) {
        throw new Error(
          `id ${id} is a ${entity.type}, not a ${def.entityType}; use design://entity/${id} for cross-type access`,
        );
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(entity, null, 2),
          },
        ],
      };
    },
  );
}

function registerPromptResource(server: McpServer, deps: ServerDeps): void {
  const template = new ResourceTemplate("design://prompt/{name}", {
    list: async () => {
      const b = deps.source.current();
      const resources = b.prompts.map((p) => ({
        uri: `design://prompt/${p.name}`,
        name: p.name,
        description: p.description ?? `Prompt template: ${p.name}`,
        mimeType: "application/json",
      }));
      return { resources };
    },
  });

  server.registerResource(
    "prompt",
    template,
    {
      title: "Design system prompt template",
      description:
        "Read a prompt template loaded from the source repo's prompts/ directory. For invocation use prompts/get instead.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = readVariable(variables.name);
      const b = deps.source.current();
      const prompt = b.prompts.find((p) => p.name === name);
      if (!prompt) throw new Error(`unknown prompt: ${name}`);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(
              {
                name: prompt.name,
                description: prompt.description ?? null,
                arguments: prompt.arguments,
                body: prompt.body,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

function readVariable(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return decodeURIComponent(typeof value === "string" ? value : "");
}

function entityResourceDescriptor(ent: Entity): {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
} {
  return {
    uri: `design://entity/${ent.id}`,
    name: ent.id,
    description: ent.summary,
    mimeType: "application/json",
  };
}
