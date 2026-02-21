/**
 * Provider layer — copied from OpenClaw's attempt.ts createAgentSession pattern.
 *
 * OpenClaw source: /opt/openclaw/src/agents/pi-embedded-runner/run/attempt.ts lines 575-586
 * Adapted for Waffle Maker by replacing auth/model variables.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { CODE_ASSIST_BASE } from "./constants.js";
import { loadTokens } from "./tokens.js";
import type { ModelInfo } from "./types.js";

// ── Model resolution (unchanged) ────────────────────────────────────────────

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

// ── Session factory (copied from OpenClaw attempt.ts) ────────────────────────

/**
 * Copied from OpenClaw's attempt.ts lines 575-586:
 *
 *   ({ session } = await createAgentSession({
 *     cwd: resolvedWorkspace,
 *     agentDir,
 *     authStorage: params.authStorage,
 *     modelRegistry: params.modelRegistry,
 *     model: params.model,
 *     thinkingLevel: mapThinkingLevel(params.thinkLevel),
 *     tools: builtInTools,
 *     customTools: allCustomTools,
 *     sessionManager,
 *     settingsManager,
 *   }));
 *
 * Adapted: we inject our OAuth token via AuthStorage.setRuntimeApiKey()
 * (same as OpenClaw's main.ts line 588: authStorage.setRuntimeApiKey(...))
 */
export async function createSession(
  model: Model<"google-gemini-cli">,
  tools: AgentTool[],
  systemPrompt: string,
  projectId: string,
): Promise<AgentSession> {
  const tokens = await loadTokens();
  if (!tokens?.access) throw new Error("No OAuth token available");

  // Same as OpenClaw main.ts: authStorage.setRuntimeApiKey(provider, apiKey)
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(
    "google-gemini-cli",
    JSON.stringify({ token: tokens.access, projectId }),
  );

  const cwd = process.cwd();
  // Same as OpenClaw attempt.ts: SettingsManager.create(cwd, agentDir)
  const settingsManager = SettingsManager.create(cwd);
  // Same as OpenClaw attempt.ts: SessionManager.open(...) — we use inMemory
  const sessionManager = SessionManager.inMemory();

  // Copied from OpenClaw attempt.ts lines 575-586
  const { session } = await createAgentSession({
    cwd,
    authStorage,
    model,
    tools: [], // no built-in coding tools
    customTools: tools, // our waffle maker tools
    sessionManager,
    settingsManager,
  });

  // Same as OpenClaw attempt.ts line 587: applySystemPromptOverrideToSession
  session.agent.setSystemPrompt(systemPrompt);

  return session;
}
