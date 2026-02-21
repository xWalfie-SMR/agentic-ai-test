/**
 * Provider layer — uses ModelRegistry.find() for model resolution
 * (same as OpenClaw's resolveModel in pi-embedded-runner/model.ts).
 *
 * Session factory copied from OpenClaw's attempt.ts createAgentSession pattern.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { CODE_ASSIST_BASE } from "./constants.js";
import { loadTokens } from "./tokens.js";
import type { ModelInfo } from "./types.js";

// ── Model resolution (via ModelRegistry, same as OpenClaw) ──────────────────

const PROVIDER = "google-antigravity";

export function toModel(info: ModelInfo): Model<Api> {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const found = modelRegistry.find(PROVIDER, info.id);
  if (found) {
    return found;
  }
  // Fallback for models not in the built-in registry
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
    provider: PROVIDER,
    baseUrl: CODE_ASSIST_BASE,
    reasoning: isReasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: isLargeContext ? 1_000_000 : 200_000,
    maxTokens: 65_536,
  };
}

// ── Session factory (copied from OpenClaw attempt.ts) ────────────────────────

export async function createSession(
  model: Model<Api>,
  tools: AgentTool[],
  systemPrompt: string,
  projectId: string,
): Promise<AgentSession> {
  const tokens = await loadTokens();
  if (!tokens?.access) throw new Error("No OAuth token available");

  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(
    PROVIDER,
    JSON.stringify({ token: tokens.access, projectId }),
  );

  const cwd = process.cwd();
  const settingsManager = SettingsManager.create(cwd);
  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    model,
    tools: [],
    customTools: tools,
    sessionManager,
    settingsManager,
  });

  session.agent.setSystemPrompt(systemPrompt);

  return session;
}
