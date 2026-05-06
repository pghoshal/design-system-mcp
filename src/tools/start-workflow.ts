import { z } from "zod";
import type { ToolHandler } from "../server/types.js";
import { ToolError } from "../util/errors.js";

export const StartWorkflowInput = z.object({
  intent: z.string().min(1).max(512).optional(),
});

export const StartWorkflowOutput = z.object({
  workflowSessionId: z.string(),
  bundleVersion: z.string(),
  requiredTools: z.array(z.string()),
  intent: z.string().optional(),
});

export const REQUIRED_WORKFLOW_TOOLS = [
  "start_workflow",
  "describe_schema",
  "search_design_system",
  "list_entities",
  "get_entity",
  "get_related",
  "inspect_coverage",
  "recommend_composition",
  "get_usage",
  "get_component_source",
  "resolve_token",
  "validate_composition",
  "validate_ui",
  "explain_decision",
] as const;

export const handler: ToolHandler<typeof StartWorkflowInput, typeof StartWorkflowOutput> = {
  name: "start_workflow",
  description:
    "Start a server-side audited design-system handoff workflow. Pass the returned workflowSessionId to every subsequent MCP tool call so validate_design_contract can prove the tools were actually used.",
  input: StartWorkflowInput,
  output: StartWorkflowOutput,
  async handle(args, ctx) {
    if (!ctx.audit) {
      throw new ToolError("internal", "workflow audit store is not available in this transport");
    }
    const input = StartWorkflowInput.parse(args);
    const bundle = ctx.source.current();
    const session = ctx.audit.start(bundle.version);
    return {
      workflowSessionId: session.id,
      bundleVersion: bundle.version,
      requiredTools: [...REQUIRED_WORKFLOW_TOOLS],
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
    };
  },
};
