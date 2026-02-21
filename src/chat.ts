#!/usr/bin/env bun
/**
 * Interactive chat via Waffle Maker (Cloud Code Assist).
 *
 * Full retained-mode TUI built on pi-tui with OpenClaw-inspired styling.
 * Supports tool use (exec, web_search, web_fetch) via Gemini function calling.
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
import {
  executeTool,
  getToolDeclarations,
  getToolSummaryLines,
} from "./tools/index.js";
import { ChatLog } from "./tui/chat-log.js";
import { CustomEditor } from "./tui/custom-editor.js";
import { editorTheme, theme } from "./tui/theme.js";
import type {
  ChatMessage,
  FunctionCall,
  ModelInfo,
  TokenData,
  TokenUsage,
} from "./types.js";

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

/** Format a tool call for display in the chat log. */
function formatToolCall(call: FunctionCall): string {
  const argsStr = Object.entries(call.args)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      // Truncate long values
      return `${k}: ${val.length > 80 ? `${val.slice(0, 77)}…` : val}`;
    })
    .join(", ");
  return `🔧 **${call.name}**(${argsStr})`;
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
  const history: ChatMessage[] = [];
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let systemPrompt = buildSystemPrompt({
    modelId: currentModel,
    displayName: getDisplayName(models, currentModel),
    workspaceDir: process.cwd(),
    ...env,
  });
  let isBusy = false;

  // Tool declarations for Gemini
  const toolDeclarations = getToolDeclarations();

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
      theme.header(`🧇 waffle maker — ${getDisplayName(models, currentModel)}`),
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
        workspaceDir: process.cwd(),
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

  // ── Send message (with tool calling loop) ───────────────────────────────
  const doSendMessage = async (text: string) => {
    if (isBusy) return;
    isBusy = true;

    chatLog.addUser(text);
    history.push({ role: "user", content: text });

    // Show streaming indicator
    setStatusBusy("streaming");

    // Agentic tool-calling loop: keep going until the model responds with text
    let loopCount = 0;
    const MAX_TOOL_LOOPS = 15;

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

      // Track thinking and content text separately during streaming
      let structuredThinking = "";
      let rawContent = "";

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

      try {
        const result = await sendMessage({
          accessToken: tokens.access,
          projectId: tokens.projectId,
          modelId: currentModel,
          messages: history,
          systemPrompt,
          tools: toolDeclarations,
          onText: (chunk) => {
            rawContent += chunk;
            refreshDisplay();
          },
          onThinking: (chunk) => {
            structuredThinking += chunk;
            refreshDisplay();
          },
          onFunctionCall: () => {},
        });

        // Accumulate token usage
        totalUsage.inputTokens += result.usage.inputTokens;
        totalUsage.outputTokens += result.usage.outputTokens;
        updateFooter();

        // Does the model want to call a tool?
        if (result.functionCall) {
          const call = result.functionCall;

          // Show the tool call in the chat log
          chatLog.finalizeAssistant(formatToolCall(call));

          // Push the function call into history
          history.push({
            role: "function_call",
            content: "",
            functionCall: call,
          });

          // Execute the tool
          setStatusBusy(`running ${call.name}…`);
          const toolResult = await executeTool(call.name, call.args);

          // Show result preview in chat
          const preview =
            toolResult.output.length > 500
              ? `${toolResult.output.slice(0, 497)}…`
              : toolResult.output;
          chatLog.addSystem(
            `${toolResult.error ? "⚠️" : "✅"} ${call.name}: ${preview}`,
          );
          tui.requestRender();

          // Push the function response into history
          history.push({
            role: "function_response",
            content: "",
            functionResponse: {
              name: call.name,
              response: {
                output: toolResult.output,
                ...(toolResult.error ? { error: true } : {}),
              },
            },
          });

          // Continue the loop — model will process the tool result
          setStatusBusy("streaming");
          continue;
        }

        // No tool call — model responded with text. Finalize.
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

        setStatusIdle(
          `${formatTokens(result.usage.inputTokens, result.usage.outputTokens)} | ready`,
        );
        break; // Done — exit the loop
      } catch (err) {
        chatLog.dropAssistant();
        if (loopCount === 1) {
          history.pop(); // Remove failed user message
        }
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
        break;
      }
    }

    if (loopCount >= MAX_TOOL_LOOPS) {
      chatLog.addSystem("⚠️ Tool loop limit reached (max 15 calls per turn).");
      setStatusIdle("tool limit | ready");
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
  console.log("🧇 Waffle Maker\n");

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
