/**
 * Antigravity Cloud Code Assist API client.
 *
 * All models (Gemini, Claude, GPT-OSS) are accessed through the same
 * Cloud Code Assist proxy:
 *
 *   Endpoint:  POST {BASE_URL}/v1internal:streamGenerateContent?alt=sse
 *   Body:      { model, project, request: { contents, generationConfig } }
 *   Response:  SSE data lines with { response: { candidates, usageMetadata } }
 *
 * The `request` field wraps a standard Gemini generateContent payload.
 */

import { CODE_ASSIST_BASE } from "./constants.js";
import type { ChatMessage, TokenUsage } from "./types.js";

// ── Internal types ───────────────────────────────────────────────────────────

/** Shape of an SSE chunk from the streamGenerateContent endpoint. */
interface StreamChunk {
  response?: {
    candidates?: Array<{
      content?: {
        role?: string;
        parts?: Array<{ text?: string }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
    };
    modelVersion?: string;
  };
}

// ── Message conversion ───────────────────────────────────────────────────────

/**
 * Convert ChatMessage[] → Gemini `contents` format.
 *
 * Gemini uses `model` for assistant messages, `user` for user messages.
 */
function toContents(messages: ChatMessage[]) {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));
}

// ── SSE stream reader ────────────────────────────────────────────────────────

async function readStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<TokenUsage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const chunk = JSON.parse(payload) as StreamChunk;
        const resp = chunk.response;
        if (!resp) continue;

        // Extract text deltas
        for (const cand of resp.candidates ?? []) {
          for (const part of cand.content?.parts ?? []) {
            if (part.text) onText(part.text);
          }
        }

        // Capture usage (last chunk with data wins)
        const usage = resp.usageMetadata;
        if (usage) {
          if (usage.promptTokenCount !== undefined)
            inputTokens = usage.promptTokenCount;
          if (usage.candidatesTokenCount !== undefined)
            outputTokens = usage.candidatesTokenCount;
        }
      } catch {
        // Skip unparseable lines.
      }
    }
  }

  return { inputTokens, outputTokens };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  /** OAuth 2.0 access token. */
  accessToken: string;
  /** Cloud Code Assist project ID. */
  projectId: string;
  /** Model key (e.g. "gemini-2.5-flash", "claude-sonnet-4-6"). */
  modelId: string;
  /** Conversation history (including the latest user message). */
  messages: ChatMessage[];
  /** Optional system prompt (sent as systemInstruction). */
  systemPrompt?: string;
  /** Maximum output tokens. Defaults to 8192. */
  maxTokens?: number;
  /** Callback invoked with each text fragment. */
  onText: (text: string) => void;
}

/**
 * Send a chat request through the Cloud Code Assist proxy and stream the
 * response.
 *
 * Works for **all model providers** (Gemini, Claude, GPT-OSS) — the proxy
 * routes to the correct backend based on the model key.
 */
export async function sendMessage(
  opts: SendMessageOptions,
): Promise<TokenUsage> {
  const url = `${CODE_ASSIST_BASE}/v1internal:streamGenerateContent?alt=sse`;

  const request: Record<string, unknown> = {
    contents: toContents(opts.messages),
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 8192,
    },
  };

  if (opts.systemPrompt) {
    request.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  const body = {
    model: opts.modelId,
    project: opts.projectId,
    request,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`API error (HTTP ${res.status}): ${errBody}`);
  }

  if (!res.body) {
    throw new Error("API returned an empty response body.");
  }

  return readStream(res.body, opts.onText);
}
