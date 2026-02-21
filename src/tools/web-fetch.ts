/**
 * web_fetch tool — fetch and extract readable content from a URL.
 *
 * Strips HTML tags and returns plain text.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const DEFAULT_MAX_LENGTH = 10_000;
const TIMEOUT_MS = 15_000;

/** Strip HTML tags and collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(
      /<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const WebFetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch." }),
  max_length: Type.Optional(
    Type.Number({
      description:
        "Maximum characters to return (default: 10000). Use a smaller value for quick lookups.",
      minimum: 100,
      maximum: 100000,
    }),
  ),
});

export const webFetchTool: AgentTool<typeof WebFetchParams> = {
  name: "web_fetch",
  label: "Fetch URL",
  description:
    "Fetch and extract readable content from a URL. " +
    "Returns the page text (HTML tags stripped). " +
    "Use for reading documentation, articles, or API responses.",
  parameters: WebFetchParams,

  async execute(
    _toolCallId: string,
    params: { url: string; max_length?: number },
  ): Promise<AgentToolResult<unknown>> {
    const url = String(params.url ?? "").trim();
    if (!url) {
      return {
        content: [{ type: "text", text: "Error: empty URL." }],
        details: { error: true },
      };
    }
    const maxLength =
      typeof params.max_length === "number"
        ? Math.max(100, Math.min(100_000, Math.floor(params.max_length)))
        : DEFAULT_MAX_LENGTH;
    const start = Date.now();
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "WaffleMaker/1.0 (web_fetch tool)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: `HTTP ${res.status}: ${res.statusText} (${url})`,
            },
          ],
          details: { error: true },
        };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const tookMs = Date.now() - start;
      let content =
        contentType.includes("text/html") || contentType.includes("xhtml")
          ? htmlToText(raw)
          : raw.trim();
      if (content.length > maxLength) {
        content = `${content.slice(0, maxLength)}\n\n... (truncated, ${content.length} total chars)`;
      }
      return {
        content: [
          {
            type: "text",
            text: `Fetched ${url} (${tookMs}ms, ${contentType.split(";")[0]}):\n\n${content}`,
          },
        ],
        details: { url, tookMs },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Fetch error (${url}): ${(err as Error).message}`,
          },
        ],
        details: { error: true },
      };
    }
  },
};
