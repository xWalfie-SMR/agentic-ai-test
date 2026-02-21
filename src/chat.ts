#!/usr/bin/env bun
/**
 * Interactive chat via Antigravity (Cloud Code Assist).
 *
 * Full retained-mode TUI built on pi-tui with OpenClaw-inspired styling.
 *
 * The API layer (api.ts, oauth.ts, tokens.ts, models.ts, types.ts) is
 * intentionally kept UI-agnostic so a future web frontend can reuse it.
 *
 * Usage:
 *   bun run chat
 */

import {
  Container,
  Loader,
  type OverlayHandle,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { sendMessage } from "./api.js";
import { fetchAvailableModels } from "./models.js";
import { getValidTokens } from "./tokens.js";
import { ChatLog } from "./tui/chat-log.js";
import { CustomEditor } from "./tui/custom-editor.js";
import { editorTheme, theme } from "./tui/theme.js";
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
    "You are an agentic AI coding assistant.",
    `Model: ${opts.displayName} (${opts.modelId}).`,
    `User environment: ${opts.distro}, desktop: ${opts.de}, shell: ${opts.shell}.`,
  ].join("\n");
}

// ── Thinking block handling ──────────────────────────────────────────────────

/**
 * Regex-based inline thinking tag stripper with code-region awareness.
 *
 * Models like Claude may embed `<thinking>...</thinking>` in their text
 * output. This strips those tags and returns what was inside them,
 * while leaving tags inside code blocks/inline code untouched.
 *
 * Modeled after OpenClaw's `stripReasoningTagsFromText()`.
 */
const QUICK_TAG_RE = /<\s*\/?(?:think(?:ing)?|thought|antthinking)\b/i;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

interface CodeRegion {
  start: number;
  end: number;
}

function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  // Fenced code blocks
  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    regions.push({ start, end: start + match[0].length - prefix.length });
  }

  // Inline code
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

/**
 * Strip inline `<thinking>` tags from text, returning separated thinking
 * and content. Tags inside code blocks/inline code are left alone.
 */
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

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

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
    // Unclosed thinking tag — treat the rest as thinking
    thinkingParts.push(raw.slice(currentThinkingStart).trim());
  } else {
    result += raw.slice(lastIndex);
  }

  return {
    thinking: thinkingParts.join("\n").trim(),
    content: result.trim(),
  };
}

/**
 * Compose thinking + content into a display string.
 * When showThinking is true and thinking text exists, prepends
 * `[thinking]\n{text}` above the content (matching OpenClaw style).
 */
function composeDisplayText(
  thinking: string,
  content: string,
  showThinking: boolean,
): string {
  const parts: string[] = [];
  if (showThinking && thinking) {
    parts.push(`[thinking]\n${thinking}`);
  }
  if (content) {
    parts.push(content);
  }
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
  env: { distro: string; de: string; shell: string },
): Promise<void> {
  // ── State ────────────────────────────────────────────────────────────────
  let currentModel = models[0]?.id ?? "";
  let showThinking = true;
  let lastCtrlCAt = 0;
  const history: ChatMessage[] = [];
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let systemPrompt = buildSystemPrompt({
    modelId: currentModel,
    displayName: getDisplayName(models, currentModel),
    ...env,
  });
  let isBusy = false;

  // ── Layout ───────────────────────────────────────────────────────────────
  const tui = new TUI(new ProcessTerminal());
  const header = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const editor = new CustomEditor(tui, editorTheme);

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(footer);
  root.addChild(editor);

  tui.addChild(root);
  tui.setFocus(editor);

  // ── Status helpers ───────────────────────────────────────────────────────
  let statusText: Text | null = null;
  let statusLoader: Loader | null = null;

  const setStatusIdle = (text: string) => {
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    statusText = new Text(theme.dim(text), 1, 0);
    statusContainer.addChild(statusText);
    tui.requestRender();
  };

  const setStatusBusy = (label: string) => {
    statusContainer.clear();
    statusText = null;
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
      theme.header(`antigravity — ${getDisplayName(models, currentModel)}`),
    );
  };

  const updateFooter = () => {
    const modelLabel = getDisplayName(models, currentModel);
    const tokens = formatTokens(
      totalUsage.inputTokens,
      totalUsage.outputTokens,
    );
    const thinkLabel = showThinking ? "on" : "off";
    const parts = [modelLabel, `think ${thinkLabel}`, tokens];
    footer.setText(theme.dim(parts.join(" | ")));
  };

  updateHeader();
  updateFooter();
  setStatusIdle("ready | /model /clear /thinking /quit");

  // ── Model selector overlay ───────────────────────────────────────────────
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

    let overlayHandle: OverlayHandle | undefined;

    list.onSelect = (item) => {
      currentModel = item.value as string;
      systemPrompt = buildSystemPrompt({
        modelId: currentModel,
        displayName: getDisplayName(models, currentModel),
        ...env,
      });
      updateHeader();
      updateFooter();
      chatLog.addSystem(`Switched to ${getDisplayName(models, currentModel)}`);
      overlayHandle?.hide();
      tui.setFocus(editor);
      tui.requestRender();
    };

    list.onCancel = () => {
      overlayHandle?.hide();
      tui.setFocus(editor);
      tui.requestRender();
    };

    overlayHandle = tui.showOverlay(list, {
      width: "60%",
      maxHeight: "60%",
      anchor: "center",
    });
    tui.setFocus(list);
  };

  // ── Send message ─────────────────────────────────────────────────────────
  const doSendMessage = async (text: string) => {
    if (isBusy) return;
    isBusy = true;

    chatLog.addUser(text);
    history.push({ role: "user", content: text });

    // Show streaming indicator
    setStatusBusy("streaming");

    // Track thinking and content text separately during streaming
    // (like OpenClaw's TuiStreamAssembler)
    let structuredThinking = "";
    let rawContent = "";

    const refreshDisplay = () => {
      // Combine structured thinking with any inline-tag thinking
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

    try {
      const usage = await sendMessage({
        accessToken: tokens.access,
        projectId: tokens.projectId,
        modelId: currentModel,
        messages: history,
        systemPrompt,
        onText: (chunk) => {
          rawContent += chunk;
          refreshDisplay();
        },
        onThinking: (chunk) => {
          structuredThinking += chunk;
          refreshDisplay();
        },
      });

      // Finalize: compute final clean text
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

      // Store clean content in history (no thinking)
      history.push({ role: "assistant", content: strippedContent });

      // Update usage
      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;
      updateFooter();
      setStatusIdle(
        `${formatTokens(usage.inputTokens, usage.outputTokens)} | ready`,
      );
    } catch (err) {
      chatLog.dropAssistant();
      history.pop(); // Remove failed user message
      chatLog.addSystem(`Error: ${(err as Error).message}`);

      // Try token refresh on 401
      if ((err as Error).message.includes("401")) {
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
    }

    isBusy = false;
    tui.requestRender();
  };

  // ── Command handling ─────────────────────────────────────────────────────
  const handleCommand = (input: string) => {
    const cmd = input.toLowerCase().trim();

    if (cmd === "/quit" || cmd === "/exit") {
      tui.stop();
      const total = totalUsage.inputTokens + totalUsage.outputTokens;
      const msgs = history.filter((m) => m.role === "user").length;
      console.log(
        `\nSession ended. ${msgs} messages, ${formatTokenCount(total)} total tokens.`,
      );
      process.exit(0);
    }

    if (cmd === "/model") {
      openModelSelector();
      return;
    }

    if (cmd === "/clear") {
      history.length = 0;
      totalUsage = { inputTokens: 0, outputTokens: 0 };
      chatLog.clearAll();
      updateFooter();
      chatLog.addSystem("Conversation cleared.");
      tui.requestRender();
      return;
    }

    if (cmd === "/thinking") {
      showThinking = !showThinking;
      updateFooter();
      chatLog.addSystem(`Thinking display: ${showThinking ? "on" : "off"}`);
      tui.requestRender();
      return;
    }

    if (cmd === "/history") {
      const msgs = history.filter((m) => m.role === "user").length;
      const total = totalUsage.inputTokens + totalUsage.outputTokens;
      chatLog.addSystem(
        `${msgs} messages | ${formatTokens(totalUsage.inputTokens, totalUsage.outputTokens)} | ${formatTokenCount(total)} total`,
      );
      tui.requestRender();
      return;
    }

    chatLog.addSystem(`Unknown command: ${cmd}`);
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

  // Show model selector on startup
  openModelSelector();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("⚡ Antigravity Chat\n");

  const tokens = await loadAuth();
  const env = await detectEnvironment();
  const models = await loadModels(tokens);

  // Clear console before entering TUI
  console.clear();

  await runTui(tokens, models, env);
}

main().catch((err) => {
  console.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
