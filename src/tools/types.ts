/**
 * Tool type re-exports from pi-agent-core.
 *
 * We use the same AgentTool type that OpenClaw uses, so the pi-ai
 * library handles conversion to Gemini's functionDeclarations automatically.
 */

export type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
