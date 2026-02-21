/**
 * Tool registry: exports all available tools as AgentTool[].
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execTool } from "./exec.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";

/** All registered tools. */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool<TObject<...>> is contravariant on execute's params — cast needed for heterogeneous array
export const allTools: AgentTool<any>[] = [
  execTool,
  createWebSearchTool(),
  createWebFetchTool(),
  // biome-ignore lint/suspicious/noExplicitAny: cast needed after filter(Boolean) on nullable factory results
].filter(Boolean) as AgentTool<any>[];

/** Get tool summaries for system prompt. */
export function getToolSummaryLines(): string[] {
  return allTools.map((t) => `- ${t.name}: ${t.description.split(".")[0]}`);
}
