#!/usr/bin/env bun

/**
 * Interactive chat via Waffle Maker (Cloud Code Assist).
 *
 * Full retained-mode TUI built on pi-tui with OpenClaw-inspired styling.
 * Uses pi-agent-core's Agent class (same as OpenClaw) for streaming,
 * tool calling, and the agentic loop.
 *
 * Usage:
 *   bun run chat
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Container,
  Loader,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { fetchAvailableModels } from "./models.js";
import { createSession, toModel } from "./provider.js";
import { getValidTokens } from "./tokens.js";
import { allTools, getToolSummaryLines } from "./tools/index.js";
import { ChatLog } from "./tui/chat-log.js";
import { getSlashCommands, helpText, parseCommand } from "./tui/commands.js";
import { CustomEditor } from "./tui/custom-editor.js";
import { editorTheme, theme } from "./tui/theme.js";
import type { ModelInfo, TokenData } from "./types.js";

// ── System prompt (ported from OpenClaw) ─────────────────────────────────────

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
  hostname: string;
}> {
  const [distro, shell, hostname] = await Promise.all([
    shellExec(
      "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2- | tr -d '\"'",
    ),
    shellExec("basename $SHELL"),
    shellExec("hostname"),
  ]);
  const de =
    process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || "unknown";
  return {
    distro: distro || "Unknown Linux",
    de: de || "unknown",
    shell: shell || "bash",
    hostname: hostname || "localhost",
  };
}

/**
 * Build the system prompt — a direct port of OpenClaw's `buildAgentSystemPrompt`,
 * adapted for Waffle Maker with local tool availability.
 */
function buildSystemPrompt(opts: {
  modelId: string;
  displayName: string;
  distro: string;
  de: string;
  shell: string;
  hostname: string;
  workspaceDir: string;
}): string {
  const toolSummaries = getToolSummaryLines();

  const lines = [
    "You are a personal assistant running inside Waffle Maker.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    ...toolSummaries,
    "",
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
    "## Workspace",
    `Your working directory is: ${opts.workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",
    "## Runtime",
    `Runtime: host=${opts.hostname} | os=${opts.distro} (${process.arch}) | model=${opts.displayName} (${opts.modelId}) | shell=${opts.shell} | desktop=${opts.de}`,
  ];

  return lines.filter(Boolean).join("\n");
}

// ── Thinking block handling ──────────────────────────────────────────────────

const QUICK_TAG_RE = /\s*\/?(?:think(?:ing)?|thought|antthinking)\b/i;
const THINKING_TAG_RE =
  /<\s*(\/?)s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

interface CodeRegion {
  start: number;
  end: number;
}

function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];
  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    regions.push({ start, end: start + match[0].length - prefix.length });
  }
  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
  }
  regions.sort((a, b) => a.start - b.start);
  return regions;
}

function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}

function stripInlineThinkingTags(raw: string): {
  thinking: string;
  content: string;
} {
  if (!raw || !QUICK_TAG_RE.test(raw)) {
    return { thinking: "", content: raw };
  }
  const codeRegions = findCodeRegions(raw);
  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  const thinkingParts: string[] = [];
  let currentThinkingStart = 0;

  for (const match of raw.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";
    if (isInsideCode(idx, codeRegions)) continue;
    if (!inThinking) {
      result += raw.slice(lastIndex, idx);
      if (!isClose) {
        inThinking = true;
        currentThinkingStart = idx + match[0].length;
      }
    } else if (isClose) {
      thinkingParts.push(raw.slice(currentThinkingStart, idx).trim());
      inThinking = false;
    }
    lastIndex = idx + match[0].length;
  }
  if (inThinking) {
    thinkingParts.push(raw.slice(currentThinkingStart).trim());
  } else {
    result += raw.slice(lastIndex);
  }
  return { thinking: thinkingParts.join("\n").trim(), content: result.trim() };
}

function composeDisplayText(
  thinking: string,
  content: string,
  showThinking: boolean,
): string {
  const parts: string[] = [];
  if (showThinking && thinking) parts.push(`[thinking]\n${thinking}`);
  if (content) parts.push(content);
  return parts.join("\n\n").trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDisplayName(models: ModelInfo[], id: string): string {
  return models.find((m) => m.id === id)?.displayName ?? id;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTokens(inputTokens: number, outputTokens: number): string {
  return `${formatTokenCount(inputTokens)} in / ${formatTokenCount(outputTokens)} out`;
}

/** Format a tool call for display in the chat log. */
function formatToolCall(toolCall: ToolCall): string {
  const argsStr = Object.entries(toolCall.arguments)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${val.length > 80 ? `${val.slice(0, 77)}…` : val}`;
    })
    .join(", ");
  return `🔧 **${toolCall.name}**(${argsStr})`;
}

// ── Pre-TUI setup (console-based) ────────────────────────────────────────────

async function loadAuth(): Promise<TokenData> {
  const tokens = await getValidTokens();
  if (!tokens) {
    console.error("No valid tokens found. Run `bun run auth` first.");
    process.exit(1);
  }
  console.log(`Authenticated as ${tokens.email ?? "(unknown)"}`);
  return tokens;
}

async function loadModels(tokens: TokenData): Promise<ModelInfo[]> {
  console.log("Fetching available models…");
  const models = await fetchAvailableModels(tokens.access, tokens.projectId);
  if (models.length === 0) {
    console.error("No models available.");
    process.exit(1);
  }
  console.log(`Found ${models.length} models.`);
  return models;
}

// ── TUI ──────────────────────────────────────────────────────────────────────

async function runTui(
  tokens: TokenData,
  models: ModelInfo[],
  env: { distro: string; de: string; shell: string; hostname: string },
): Promise<void> {
  // ── State ────────────────────────────────────────────────────────────────
  let currentModel = models[0]?.id ?? "";
  let showThinking = true;
  let lastCtrlCAt = 0;
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let isBusy = false;

  // Create AgentSession using createAgentSession (same as OpenClaw)
  const initialModelInfo =
    models.find((m) => m.id === currentModel) ?? models[0];
  if (!initialModelInfo) throw new Error("No models available");
  let session: AgentSession = await createSession(
    toModel(initialModelInfo),
    allTools,
    buildSystemPrompt({
      modelId: currentModel,
      displayName: getDisplayName(models, currentModel),
      workspaceDir: process.cwd(),
      ...env,
    }),
    tokens.projectId,
  );

  // Helper to rebuild session when model changes
  const rebuildAgent = async () => {
    const modelInfo = models.find((m) => m.id === currentModel) ?? models[0];
    if (!modelInfo) return;
    session = await createSession(
      toModel(modelInfo),
      allTools,
      buildSystemPrompt({
        modelId: currentModel,
        displayName: getDisplayName(models, currentModel),
        workspaceDir: process.cwd(),
        ...env,
      }),
      tokens.projectId,
    );
  };

  // ── Layout ───────────────────────────────────────────────────────────────
  const tui = new TUI(new ProcessTerminal());
  const header = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const editor = new CustomEditor(tui, editorTheme);

  // Slash command autocomplete (copied from OpenClaw tui.ts)
  const slashCommands = getSlashCommands();
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands),
  );

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(footer);
  root.addChild(editor);

  tui.addChild(root);
  tui.setFocus(editor);

  // ── Status helpers ───────────────────────────────────────────────────────
  let statusLoader: Loader | null = null;

  const setStatusIdle = (text: string) => {
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    const statusText = new Text(theme.dim(text), 1, 0);
    statusContainer.addChild(statusText);
    tui.requestRender();
  };

  const setStatusBusy = (label: string) => {
    statusContainer.clear();
    statusLoader = new Loader(
      tui,
      (spinner) => theme.accent(spinner),
      (text) => theme.bold(theme.accentSoft(text)),
      label,
    );
    statusContainer.addChild(statusLoader);
    tui.requestRender();
  };

  // ── Header / Footer ─────────────────────────────────────────────────────
  const updateHeader = () => {
    header.setText(
      theme.header(`🧇 waffle maker — ${getDisplayName(models, currentModel)}`),
    );
  };

  const updateFooter = () => {
    const modelLabel = getDisplayName(models, currentModel);
    const tkns = formatTokens(totalUsage.inputTokens, totalUsage.outputTokens);
    const thinkLabel = showThinking ? "on" : "off";
    const parts = [modelLabel, `think ${thinkLabel}`, tkns];
    footer.setText(theme.dim(parts.join(" | ")));
  };

  updateHeader();
  updateFooter();
  setStatusIdle("ready | /help for commands");

  // ── Model selector (OpenClaw showSelector pattern) ────────────────────────
  // Replaces the editor with a full-height selector, then restores on done.
  // Copied from OpenClaw interactive-mode.ts showSelector() + showModelSelector().
  const openModelSelector = () => {
    const items: SelectItem[] = models.map((m) => ({
      label: m.displayName ?? m.id,
      value: m.id,
      description:
        m.remainingQuota !== undefined
          ? `${Math.round(m.remainingQuota * 100)}% remaining`
          : undefined,
    }));

    const list = new SelectList(items, 20, editorTheme.selectList);

    // done() restores the editor (same as OpenClaw's showSelector)
    const done = () => {
      root.removeChild(list);
      root.addChild(editor);
      tui.setFocus(editor);
      tui.requestRender();
    };

    list.onSelect = (item) => {
      currentModel = item.value as string;
      void rebuildAgent();
      updateHeader();
      updateFooter();
      chatLog.addSystem(`Switched to ${getDisplayName(models, currentModel)}`);
      done();
    };

    list.onCancel = () => {
      done();
    };

    // Replace editor with selector (OpenClaw pattern)
    root.removeChild(editor);
    root.addChild(list);
    tui.setFocus(list);
    tui.requestRender();
  };

  // ── Send message (Agent-based — pi-agent-core handles the tool loop) ───
  const doSendMessage = async (text: string) => {
    if (isBusy) return;
    isBusy = true;

    chatLog.addUser(text);
    setStatusBusy("streaming");

    // Track streaming state for TUI display
    let structuredThinking = "";
    let rawContent = "";
    // Using a mutable wrapper so reassignment inside callbacks is visible to outer scope
    const usageRef: { input: number; output: number; valid: boolean } = {
      input: 0,
      output: 0,
      valid: false,
    };

    const refreshDisplay = () => {
      const { thinking: inlineThinking, content: strippedContent } =
        stripInlineThinkingTags(rawContent);
      const allThinking = [structuredThinking, inlineThinking]
        .filter(Boolean)
        .join("\n");
      const display = composeDisplayText(
        allThinking,
        strippedContent,
        showThinking,
      );
      chatLog.updateAssistant(display || "…");
      tui.requestRender();
    };

    // Subscribe to agent events for TUI display
    const unsubscribe = session.agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") {
            rawContent += e.delta;
            refreshDisplay();
          } else if (e.type === "thinking_delta") {
            structuredThinking += e.delta;
            refreshDisplay();
          }
          // Track usage from the partial message
          if ("partial" in e && e.partial) {
            const msg = e.partial as AssistantMessage;
            if (msg.usage) {
              usageRef.input = msg.usage.input;
              usageRef.output = msg.usage.output;
              usageRef.valid = true;
            }
          }
          break;
        }
        case "message_end": {
          // Extract final usage and check for errors
          const msg = event.message;
          if (msg && "usage" in msg) {
            const aMsg = msg as AssistantMessage;
            usageRef.input = aMsg.usage.input;
            usageRef.output = aMsg.usage.output;
            usageRef.valid = true;
          }
          // Surface API errors as assistant content so they don't show as "(no output)"
          if (
            msg &&
            "errorMessage" in msg &&
            (msg as unknown as Record<string, unknown>).errorMessage &&
            !rawContent.trim()
          ) {
            rawContent = `⚠️ ${(msg as unknown as Record<string, unknown>).errorMessage as string}`;
          }
          break;
        }
        case "tool_execution_start": {
          // Finalize any current assistant text, show the tool call
          if (rawContent.trim()) {
            const { thinking: inlineThinking, content: strippedContent } =
              stripInlineThinkingTags(rawContent);
            const allThinking = [structuredThinking, inlineThinking]
              .filter(Boolean)
              .join("\n");
            const display = composeDisplayText(
              allThinking,
              strippedContent,
              showThinking,
            );
            chatLog.finalizeAssistant(display);
            rawContent = "";
            structuredThinking = "";
          }

          // Show tool call
          const tc: ToolCall = {
            type: "toolCall",
            id: event.toolCallId,
            name: event.toolName,
            arguments: event.args ?? {},
          };
          chatLog.addSystem(formatToolCall(tc));
          setStatusBusy(`running ${event.toolName}…`);
          tui.requestRender();
          break;
        }
        case "tool_execution_end": {
          // Show result preview
          const resultText =
            event.result?.content
              ?.map((c: { type: string; text?: string }) =>
                c.type === "text" ? c.text : "",
              )
              .join("") ?? JSON.stringify(event.result);
          const preview =
            resultText.length > 500
              ? `${resultText.slice(0, 497)}…`
              : resultText;
          const icon = event.isError ? "⚠️" : "✅";
          chatLog.addSystem(`${icon} ${event.toolName}: ${preview}`);
          setStatusBusy("streaming");
          tui.requestRender();
          break;
        }
        case "turn_start": {
          // Reset content tracking for new turn (after tool results)
          rawContent = "";
          structuredThinking = "";
          break;
        }
        case "agent_end": {
          break;
        }
        default:
          break;
      }
    });

    try {
      await session.prompt(text);

      // Accumulate token usage
      if (usageRef.valid) {
        totalUsage.inputTokens += usageRef.input;
        totalUsage.outputTokens += usageRef.output;
      }
      updateFooter();

      // Finalize the last assistant message
      const { thinking: inlineThinking, content: strippedContent } =
        stripInlineThinkingTags(rawContent);
      const allThinking = [structuredThinking, inlineThinking]
        .filter(Boolean)
        .join("\n");
      const finalDisplay = composeDisplayText(
        allThinking,
        strippedContent,
        showThinking,
      );
      chatLog.finalizeAssistant(finalDisplay || "(no output)");

      const statusParts: string[] = [];
      if (usageRef.valid) {
        statusParts.push(formatTokens(usageRef.input, usageRef.output));
      }
      statusParts.push("ready");
      setStatusIdle(statusParts.join(" | "));
    } catch (err) {
      chatLog.dropAssistant();
      chatLog.addSystem(`Error: ${(err as Error).message}`);

      // Try token refresh on auth errors
      if (
        (err as Error).message.includes("401") ||
        (err as Error).message.includes("OAuth")
      ) {
        chatLog.addSystem("Attempting token refresh…");
        const refreshed = await getValidTokens();
        if (refreshed) {
          tokens.access = refreshed.access;
          tokens.expires = refreshed.expires;
          chatLog.addSystem("Token refreshed. Try again.");
        } else {
          chatLog.addSystem("Refresh failed. Run `bun run auth`.");
        }
      }
      setStatusIdle("error | ready");
    } finally {
      unsubscribe();
      isBusy = false;
      tui.requestRender();
    }
  };

  // ── Command handling ─────────────────────────────────────────────────────
  // Command handling (uses parseCommand from OpenClaw commands.ts)
  const handleCommand = (input: string) => {
    const { name, args } = parseCommand(input);
    if (!name) return;

    switch (name) {
      case "help":
        chatLog.addSystem(helpText());
        break;
      case "model":
      case "models":
        openModelSelector();
        break;
      case "think": {
        if (!args) {
          chatLog.addSystem("usage: /think <on|off>");
          break;
        }
        const level = args.toLowerCase();
        if (level === "on" || level === "off") {
          showThinking = level === "on";
          updateFooter();
          chatLog.addSystem(`thinking set to ${level}`);
        } else {
          chatLog.addSystem("usage: /think <on|off>");
        }
        break;
      }
      case "new":
      case "reset":
        totalUsage = { inputTokens: 0, outputTokens: 0 };
        chatLog.clearAll();
        void rebuildAgent();
        updateFooter();
        chatLog.addSystem("session reset");
        break;
      case "abort":
        if (!isBusy) {
          chatLog.addSystem("nothing to abort");
        } else {
          chatLog.addSystem("aborting...");
          // The abort is handled via the stream — set flag so next loop breaks
          isBusy = false;
        }
        break;
      case "settings": {
        chatLog.addSystem(
          [
            "Settings:",
            `  thinking: ${showThinking ? "on" : "off"}`,
            `  model: ${currentModel}`,
            `  tokens: ${formatTokens(totalUsage.inputTokens, totalUsage.outputTokens)}`,
          ].join("\n"),
        );
        break;
      }
      case "exit":
      case "quit":
        tui.stop();
        console.log(
          `\nSession ended. ${formatTokenCount(totalUsage.inputTokens + totalUsage.outputTokens)} total tokens.`,
        );
        process.exit(0);
        break;
      default:
        chatLog.addSystem(
          `Unknown command: ${name}. Type /help for available commands.`,
        );
        break;
    }
    tui.requestRender();
  };

  // ── Editor wiring ────────────────────────────────────────────────────────
  editor.onSubmit = (text: string) => {
    const value = text.trim();
    editor.setText("");
    if (!value) return;

    editor.addToHistory(value);

    if (value.startsWith("/")) {
      handleCommand(value);
      return;
    }

    void doSendMessage(value);
  };

  editor.onCtrlC = () => {
    if (isBusy) {
      session.agent.abort();
      setStatusIdle("aborted | ready");
      isBusy = false;
      tui.requestRender();
      return;
    }
    if (editor.getText().trim().length > 0) {
      editor.setText("");
      setStatusIdle("cleared input | ready");
      tui.requestRender();
      return;
    }
    const now = Date.now();
    if (now - lastCtrlCAt < 1000) {
      tui.stop();
      process.exit(0);
    }
    lastCtrlCAt = now;
    setStatusIdle("press ctrl+c again to exit");
    tui.requestRender();
  };

  editor.onCtrlD = () => {
    tui.stop();
    process.exit(0);
  };

  editor.onCtrlT = () => {
    showThinking = !showThinking;
    updateFooter();
    chatLog.addSystem(`Thinking display: ${showThinking ? "on" : "off"}`);
    tui.requestRender();
  };

  // ── Start ────────────────────────────────────────────────────────────────
  tui.start();
  openModelSelector();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🧇 Waffle Maker\n");

  const tokens = await loadAuth();
  const env = await detectEnvironment();
  const models = await loadModels(tokens);

  console.clear();

  await runTui(tokens, models, env);
}

main().catch((err) => {
  console.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
