#!/usr/bin/env bun
/**
 * Interactive chat via Antigravity (Cloud Code Assist).
 *
 * Supports all available models (Gemini, Claude, GPT-OSS) through a
 * unified Cloud Code Assist proxy.
 *
 * This script provides a full interactive chat experience:
 *
 *   1. Loads & validates saved OAuth tokens (auto-refreshes if expired).
 *   2. Fetches available models from the Cloud Code Assist API.
 *   3. Presents an interactive model picker with quota information.
 *   4. Enters a chat loop: prompt → stream response → repeat.
 *
 * Commands:
 *   /quit, /exit   — End the session.
 *   /model         — Switch to a different model.
 *   /clear         — Clear conversation history and start fresh.
 *   /history       — Show message count and cumulative token usage.
 *
 * Usage:
 *   bun run chat
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { sendMessage } from "./api.js";
import { fetchAvailableModels } from "./models.js";
import { getValidTokens } from "./tokens.js";
import type { ChatMessage, ModelInfo, TokenData, TokenUsage } from "./types.js";

// ── System prompt ────────────────────────────────────────────────────────────

/** Run a shell command and return trimmed stdout (empty string on failure). */
async function shellExec(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    return out.trim();
  } catch {
    return "";
  }
}

/** Detect runtime environment info (distro, DE, shell). */
async function detectEnvironment(): Promise<{
  distro: string;
  de: string;
  shell: string;
}> {
  const [distro, shell] = await Promise.all([
    shellExec(
      "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2- | tr -d '\"'",
    ),
    shellExec("basename $SHELL"),
  ]);
  const de =
    process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || "unknown";
  return {
    distro: distro || "Unknown Linux",
    de: de || "unknown",
    shell: shell || "bash",
  };
}

/** Build a system prompt for the selected model. */
function buildSystemPrompt(opts: {
  modelId: string;
  displayName: string;
  distro: string;
  de: string;
  shell: string;
}): string {
  return [
    `You are an agentic AI coding assistant.`,
    `Model: ${opts.displayName} (${opts.modelId}).`,
    `User environment: ${opts.distro}, desktop: ${opts.de}, shell: ${opts.shell}.`,
  ].join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a remaining-quota fraction as a colored percentage string.
 * Green above 50%, yellow 20–50%, red below 20%.
 */
function formatQuota(fraction: number | undefined): string {
  if (fraction === undefined) return color.dim("quota unknown");
  const pct = Math.round(fraction * 100);
  const label = `${pct}% remaining`;
  if (pct > 50) return color.green(label);
  if (pct > 20) return color.yellow(label);
  return color.red(label);
}

/**
 * Build select options for the model picker.
 */
function buildModelOptions(
  models: ModelInfo[],
): Array<{ value: string; label: string; hint?: string }> {
  return models.map((m) => ({
    value: m.id,
    label: m.displayName ?? m.id,
    hint: formatQuota(m.remainingQuota),
  }));
}

/** Check whether the user cancelled a prompt (Ctrl+C). */
function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Session cancelled.");
    process.exit(0);
  }
}

// ── Interactive flows ────────────────────────────────────────────────────────

/**
 * Prompt the user to select a model from the available list.
 */
async function selectModel(models: ModelInfo[]): Promise<string> {
  const options = buildModelOptions(models);
  const selection = await p.select({
    message: "Select a model",
    options,
  });
  assertNotCancelled(selection);
  return selection as string;
}

/**
 * Fetch models with a spinner, returning the model list.
 */
async function fetchModelsWithSpinner(tokens: TokenData): Promise<ModelInfo[]> {
  const spin = p.spinner();
  spin.start("Fetching available models…");

  try {
    const models = await fetchAvailableModels(tokens.access, tokens.projectId);
    if (models.length === 0) {
      spin.stop("No models available");
      p.log.error(
        "The API returned no available models. Your account may not have access.",
      );
      process.exit(1);
    }
    spin.stop(`Found ${models.length} available models`);
    return models;
  } catch (err) {
    spin.stop("Failed to fetch models");
    p.log.error(`Could not fetch models: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── Chat loop ────────────────────────────────────────────────────────────────

async function chatLoop(
  tokens: TokenData,
  modelId: string,
  models: ModelInfo[],
  env: { distro: string; de: string; shell: string },
): Promise<void> {
  const history: ChatMessage[] = [];
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let currentModel = modelId;

  const getDisplayName = (id: string) =>
    models.find((m) => m.id === id)?.displayName ?? id;

  let systemPrompt = buildSystemPrompt({
    modelId: currentModel,
    displayName: getDisplayName(currentModel),
    ...env,
  });

  p.log.info(`Using model: ${color.cyan(currentModel)}`);
  p.log.message(color.dim("Commands: /model /clear /history /quit"));

  while (true) {
    const input = await p.text({
      message: color.cyan("You"),
      placeholder: "Type your message…",
    });
    assertNotCancelled(input);

    const message = (input as string).trim();
    if (!message) continue;

    // ── Slash commands ─────────────────────────────────────────────────────
    if (message.startsWith("/")) {
      const cmd = message.toLowerCase();

      if (cmd === "/quit" || cmd === "/exit") {
        break;
      }

      if (cmd === "/model") {
        const newModel = await selectModel(models);
        currentModel = newModel;
        systemPrompt = buildSystemPrompt({
          modelId: currentModel,
          displayName: getDisplayName(currentModel),
          ...env,
        });
        p.log.info(`Switched to: ${color.cyan(currentModel)}`);
        continue;
      }

      if (cmd === "/clear") {
        history.length = 0;
        totalUsage = { inputTokens: 0, outputTokens: 0 };
        p.log.info("Conversation cleared.");
        continue;
      }

      if (cmd === "/history") {
        p.log.info(
          `Messages: ${history.length} | ` +
            `Tokens: ${totalUsage.inputTokens} in / ${totalUsage.outputTokens} out`,
        );
        continue;
      }

      p.log.warn(`Unknown command: ${cmd}`);
      continue;
    }

    // ── Send message ───────────────────────────────────────────────────────
    history.push({ role: "user", content: message });

    // Collect assistant response text as it streams.
    let responseText = "";
    const modelLabel = currentModel
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    process.stdout.write(`\n${color.dim(modelLabel)} `);

    try {
      const usage = await sendMessage({
        accessToken: tokens.access,
        projectId: tokens.projectId,
        modelId: currentModel,
        messages: history,
        systemPrompt,
        onText: (text) => {
          responseText += text;
          process.stdout.write(text);
        },
      });

      process.stdout.write("\n\n");

      // Track the assistant response in history.
      history.push({ role: "assistant", content: responseText });

      // Accumulate usage.
      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;

      p.log.message(
        color.dim(
          `tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`,
        ),
      );
    } catch (err) {
      process.stdout.write("\n");
      p.log.error(`Request failed: ${(err as Error).message}`);

      // Remove the user message from history since it failed.
      history.pop();

      // Check if it's a token expiry error — try to refresh.
      if ((err as Error).message.includes("401")) {
        p.log.warn("Access token may have expired. Attempting refresh…");
        const refreshed = await getValidTokens();
        if (refreshed) {
          tokens.access = refreshed.access;
          tokens.expires = refreshed.expires;
          p.log.info("Token refreshed. Please try your message again.");
        } else {
          p.log.error(
            "Token refresh failed. Run `bun run auth` to re-authenticate.",
          );
          break;
        }
      }
    }
  }

  // ── Session summary ────────────────────────────────────────────────────────
  p.outro(
    `Session ended. ${history.filter((m) => m.role === "user").length} messages, ` +
      `${totalUsage.inputTokens + totalUsage.outputTokens} total tokens.`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  p.intro(color.bgCyan(color.black(" Antigravity Chat ")));

  // 1. Load tokens
  const tokens = await getValidTokens();
  if (!tokens) {
    p.log.error("No valid tokens found. Run `bun run auth` first.");
    p.outro("Authentication required.");
    process.exit(1);
  }

  p.log.success(`Authenticated as ${color.cyan(tokens.email ?? "(unknown)")}`);
  p.log.message(color.dim(`Project: ${tokens.projectId}`));

  // 2. Detect user environment
  const env = await detectEnvironment();

  // 3. Fetch available models
  const models = await fetchModelsWithSpinner(tokens);

  // 4. Select initial model
  const modelId = await selectModel(models);

  // 5. Chat loop
  await chatLoop(tokens, modelId, models, env);
}

main().catch((err) => {
  p.log.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
