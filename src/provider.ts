/**
 * Provider layer using @mariozechner/pi-ai — matches OpenClaw's architecture.
 *
 * Creates Model objects for the google-gemini-cli API (Cloud Code Assist proxy)
 * and provides an Agent factory with tools pre-wired.
 */

import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { CODE_ASSIST_BASE } from "./constants.js";
import { loadTokens } from "./tokens.js";
import type { ModelInfo } from "./types.js";

// ───────────────────────────────────────────────
// Model resolution
// ───────────────────────────────────────────────

/**
 * Create a pi-ai Model<"google-gemini-cli"> from our ModelInfo.
 *
 * The google-gemini-cli provider in pi-ai handles the Cloud Code Assist
 * proxy including tools, thinking, SSE streaming, etc.
 */
export function toModel(info: ModelInfo): Model<"google-gemini-cli"> {
  const isReasoning =
    /think|reason/i.test(info.id) ||
    /think|reason/i.test(info.displayName ?? "");
  const isLargeContext = /gemini.*2\.5|claude.*opus|claude.*sonnet/i.test(
    info.id,
  );

  return {
    id: info.id,
    name: info.displayName ?? info.id,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: CODE_ASSIST_BASE,
    reasoning: isReasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: isLargeContext ? 1_000_000 : 200_000,
    maxTokens: 65_536,
  };
}

// ───────────────────────────────────────────────
// Agent factory
// ───────────────────────────────────────────────

/**
 * Create a pi-agent-core Agent wired for Cloud Code Assist.
 *
 * The Agent handles:
 *  - Streaming via streamSimple (google-gemini-cli provider)
 *  - Tool calling loop (model calls tool → execute → feed back → repeat)
 *  - Message history
 *  - Abort/timeout
 *
 * The google-gemini-cli provider expects apiKey to be a JSON-encoded
 * string: `{ token, projectId }`.
 *
 * @param model - Model object from toModel()
 * @param tools - AgentTool[] to register
 * @param systemPrompt - System prompt text
 * @param projectId - Cloud Code Assist project ID
 */
export function createAgent(
  model: Model<"google-gemini-cli">,
  tools: AgentTool[],
  systemPrompt: string,
  projectId: string,
): Agent {
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt,
    },
    streamFn: streamSimple,
    // Provide the OAuth access token for each LLM call.
    // The google-gemini-cli provider expects apiKey to be JSON: { token, projectId }
    getApiKey: async (_provider: string) => {
      const tokens = await loadTokens();
      if (!tokens?.access) return undefined;
      return JSON.stringify({ token: tokens.access, projectId });
    },
  });

  return agent;
}
