/**
 * Tool registry — exports all available tools and helpers.
 */

import { execTool } from "./exec.js";
import type { GeminiFunctionDeclaration, Tool, ToolResult } from "./types.js";
import { toFunctionDeclarations } from "./types.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

/** All registered tools. */
export const allTools: Tool[] = [execTool, webSearchTool, webFetchTool];

/** Map for O(1) lookup by name. */
const toolMap = new Map<string, Tool>(allTools.map((t) => [t.name, t]));

/** Get Gemini functionDeclarations for all tools. */
export function getToolDeclarations(): GeminiFunctionDeclaration[] {
  return toFunctionDeclarations(allTools);
}

/** Get tool summaries for system prompt. */
export function getToolSummaryLines(): string[] {
  return allTools.map((t) => `- ${t.name}: ${t.description.split(".")[0]}`);
}

/** Execute a tool by name. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { output: `Unknown tool: ${name}`, error: true };
  }
  return tool.execute(args);
}

export type { Tool, ToolResult, GeminiFunctionDeclaration };
