/**
 * web_fetch tool — fetch and extract readable content from a URL.
 *
 * Strips HTML tags and returns plain text, truncated to a configurable
 * max length to avoid overwhelming the model context.
 */

import type { Tool, ToolResult } from "./types.js";

const DEFAULT_MAX_LENGTH = 10_000;
const TIMEOUT_MS = 15_000;

/** Strip HTML tags and collapse whitespace. */
function htmlToText(html: string): string {
  return (
    html
      // Remove script/style blocks
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // Replace block elements with newlines
      .replace(
        /<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi,
        "\n",
      )
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode common entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch and extract readable content from a URL. " +
    "Returns the page text (HTML tags stripped). " +
    "Use for reading documentation, articles, or API responses.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch.",
      },
      max_length: {
        type: "number",
        description:
          "Maximum characters to return (default: 10000). Use a smaller value for quick lookups.",
        minimum: 100,
        maximum: 100000,
      },
    },
    required: ["url"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url ?? "").trim();
    if (!url) {
      return { output: "Error: empty URL.", error: true };
    }

    const maxLength =
      typeof args.max_length === "number"
        ? Math.max(100, Math.min(100_000, Math.floor(args.max_length)))
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
          output: `HTTP ${res.status}: ${res.statusText} (${url})`,
          error: true,
        };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const tookMs = Date.now() - start;

      let content: string;
      if (contentType.includes("text/html") || contentType.includes("xhtml")) {
        content = htmlToText(raw);
      } else {
        // Plain text, JSON, XML, etc. — return as-is
        content = raw.trim();
      }

      // Truncate
      if (content.length > maxLength) {
        content = `${content.slice(0, maxLength)}\n\n... (truncated, ${content.length} total chars)`;
      }

      return {
        output: `Fetched ${url} (${tookMs}ms, ${contentType.split(";")[0]}):\n\n${content}`,
      };
    } catch (err) {
      return {
        output: `Fetch error (${url}): ${(err as Error).message}`,
        error: true,
      };
    }
  },
};
