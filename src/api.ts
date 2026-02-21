/**
 * Waffle Maker Cloud Code Assist API client.
 *
 * All models (Gemini, Claude, GPT-OSS) are accessed through the same
 * Cloud Code Assist proxy:
 *
 *   Endpoint:  POST {BASE_URL}/v1internal:streamGenerateContent?alt=sse
 *   Body:      { model, project, request: { contents, generationConfig, tools } }
 *   Response:  SSE data lines with { response: { candidates, usageMetadata } }
 *
 * The `request` field wraps a standard Gemini generateContent payload.
 * Function calling is supported via `tools` with `functionDeclarations`.
 */

import { CODE_ASSIST_BASE } from "./constants.js";
import type { GeminiFunctionDeclaration } from "./tools/types.js";
import type { ChatMessage, FunctionCall, TokenUsage } from "./types.js";

// ── Internal types ───────────────────────────────────────────────────────────

/** Shape of an SSE chunk from the streamGenerateContent endpoint. */
interface StreamChunk {
  response?: {
    candidates?: Array<{
      content?: {
        role?: string;
        parts?: Array<{
          text?: string;
          thought?: boolean;
          functionCall?: {
            name: string;
            args: Record<string, unknown>;
          };
        }>;
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
 * Function call and response messages are serialized as model/user parts
 * with functionCall / functionResponse part types.
 */
function toContents(messages: ChatMessage[]) {
  return messages.map((msg) => {
    if (msg.role === "function_call" && msg.functionCall) {
      return {
        role: "model",
        parts: [
          {
            functionCall: {
              name: msg.functionCall.name,
              args: msg.functionCall.args,
            },
          },
        ],
      };
    }
    if (msg.role === "function_response" && msg.functionResponse) {
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.functionResponse.name,
              response: msg.functionResponse.response,
            },
          },
        ],
      };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    };
  });
}

// ── SSE stream reader ────────────────────────────────────────────────────────

interface StreamCallbacks {
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
  onFunctionCall?: (call: FunctionCall) => void;
}

/** Result of reading a stream — may end with text or a function call. */
export interface StreamResult {
  usage: TokenUsage;
  /** If the model wants to call a function, this will be set. */
  functionCall?: FunctionCall;
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let pendingFunctionCall: FunctionCall | undefined;

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

        // Extract text/thinking/functionCall deltas from parts
        for (const cand of resp.candidates ?? []) {
          for (const part of cand.content?.parts ?? []) {
            // Function call
            if (part.functionCall) {
              pendingFunctionCall = {
                name: part.functionCall.name,
                args: part.functionCall.args,
              };
              callbacks.onFunctionCall?.(pendingFunctionCall);
              continue;
            }

            // Text
            if (!part.text) continue;
            if (part.thought && callbacks.onThinking) {
              // Structured thinking block (Gemini models)
              callbacks.onThinking(part.text);
            } else {
              callbacks.onText(part.text);
            }
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

  return {
    usage: { inputTokens, outputTokens },
    functionCall: pendingFunctionCall,
  };
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
  /** Maximum output tokens. Defaults to 16384. */
  maxTokens?: number;
  /** Gemini function declarations for tool use. */
  tools?: GeminiFunctionDeclaration[];
  /** Callback invoked with each text fragment. */
  onText: (text: string) => void;
  /**
   * Callback invoked with thinking/reasoning fragments.
   * Gemini models emit structured thinking parts (`thought: true`).
   * If not provided, thinking parts are routed to `onText`.
   */
  onThinking?: (text: string) => void;
  /** Callback invoked when the model wants to call a function. */
  onFunctionCall?: (call: FunctionCall) => void;
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
): Promise<StreamResult> {
  const url = `${CODE_ASSIST_BASE}/v1internal:streamGenerateContent?alt=sse`;

  const request: Record<string, unknown> = {
    contents: toContents(opts.messages),
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 16384,
    },
  };

  if (opts.systemPrompt) {
    request.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  // Add tool declarations
  if (opts.tools && opts.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: opts.tools,
      },
    ];
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
      "User-Agent": "waffle-maker",
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

  return readStream(res.body, {
    onText: opts.onText,
    onThinking: opts.onThinking,
    onFunctionCall: opts.onFunctionCall,
  });
}
