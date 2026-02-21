/**
 * Tool registry — exports all available tools as AgentTool[].
 *
 * Uses the same AgentTool type from pi-agent-core that OpenClaw uses.
 * The pi-ai library automatically converts these to Gemini functionDeclarations.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execTool } from "./exec.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

/** All registered tools. */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool<TObject<...>> is contravariant on execute's params — cast needed for heterogeneous array
export const allTools: AgentTool<any>[] = [
  execTool,
  webSearchTool,
  webFetchTool,
];

/** Get tool summaries for system prompt. */
export function getToolSummaryLines(): string[] {
  return allTools.map((t) => `- ${t.name}: ${t.description.split(".")[0]}`);
}
