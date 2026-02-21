/**
 * web_search tool — search the web.
 *
 * Uses Serper.dev (free tier: 2,500 Google searches, no credit card).
 * Set SERPER_API_KEY env var to enable.
 * Falls back to DuckDuckGo Instant Answer API (no key needed) when
 * Serper is not configured.
 */

import type { Tool, ToolResult } from "./types.js";

const SERPER_ENDPOINT = "https://google.serper.dev/search";
const DDG_ENDPOINT = "https://api.duckduckgo.com/";
const DEFAULT_COUNT = 5;
const TIMEOUT_MS = 15_000;

interface SerperResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperResult[];
  answerBox?: {
    title?: string;
    answer?: string;
    snippet?: string;
  };
  knowledgeGraph?: {
    title?: string;
    description?: string;
  };
}

interface DdgResponse {
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
  }>;
}

async function searchSerper(
  query: string,
  apiKey: string,
  count: number,
): Promise<ToolResult> {
  const res = await fetch(SERPER_ENDPOINT, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: count }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return {
      output: `Serper API error (${res.status}): ${detail || res.statusText}`,
      error: true,
    };
  }

  const data = (await res.json()) as SerperResponse;
  const parts: string[] = [`Web search results for: "${query}"\n`];

  // Answer box
  if (data.answerBox?.answer || data.answerBox?.snippet) {
    parts.push(
      `**Answer:** ${data.answerBox.answer || data.answerBox.snippet}\n`,
    );
  }

  // Knowledge graph
  if (data.knowledgeGraph?.title) {
    parts.push(
      `**${data.knowledgeGraph.title}:** ${data.knowledgeGraph.description || ""}\n`,
    );
  }

  // Organic results
  for (const result of data.organic ?? []) {
    parts.push(
      `${result.position ?? "-"}. **${result.title ?? "Untitled"}**`,
      `   ${result.link ?? ""}`,
      `   ${result.snippet ?? ""}\n`,
    );
  }

  return { output: parts.join("\n") };
}

async function searchDdg(query: string): Promise<ToolResult> {
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    return {
      output: `DuckDuckGo API error (${res.status}): ${res.statusText}`,
      error: true,
    };
  }

  const data = (await res.json()) as DdgResponse;
  const parts: string[] = [`Web search results for: "${query}"\n`];

  if (data.Heading) {
    parts.push(`**${data.Heading}**`);
  }
  if (data.AbstractText) {
    parts.push(`${data.AbstractText}`);
    if (data.AbstractURL) {
      parts.push(`Source: ${data.AbstractURL}\n`);
    }
  }

  // Related topics as lightweight results
  for (const topic of (data.RelatedTopics ?? []).slice(0, DEFAULT_COUNT)) {
    if (topic.Text) {
      parts.push(`- ${topic.Text}`);
      if (topic.FirstURL) {
        parts.push(`  ${topic.FirstURL}`);
      }
    }
  }

  if (parts.length <= 1) {
    parts.push(
      "(No instant answer available. Try a more specific query, or use web_fetch on a search engine URL.)",
    );
  }

  return { output: parts.join("\n") };
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs, and snippets. " +
    "Uses Google via Serper.dev when SERPER_API_KEY is set, " +
    "otherwise falls back to DuckDuckGo.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string.",
      },
      count: {
        type: "number",
        description: "Number of results (1-10, default 5). Serper only.",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { output: "Error: empty search query.", error: true };
    }

    const count =
      typeof args.count === "number"
        ? Math.max(1, Math.min(10, Math.floor(args.count)))
        : DEFAULT_COUNT;

    const serperKey = process.env.SERPER_API_KEY?.trim();
    try {
      if (serperKey) {
        return await searchSerper(query, serperKey, count);
      }
      return await searchDdg(query);
    } catch (err) {
      return {
        output: `Web search error: ${(err as Error).message}`,
        error: true,
      };
    }
  },
};
