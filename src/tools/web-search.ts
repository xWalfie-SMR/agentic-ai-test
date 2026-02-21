/**
 * web_search tool — search the web.
 *
 * Uses Serper.dev when SERPER_API_KEY is set, otherwise falls back
 * to DuckDuckGo Instant Answer API.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

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
  answerBox?: { title?: string; answer?: string; snippet?: string };
  knowledgeGraph?: { title?: string; description?: string };
}

interface DdgResponse {
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

async function searchSerper(
  query: string,
  apiKey: string,
  count: number,
): Promise<string> {
  const res = await fetch(SERPER_ENDPOINT, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: count }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Serper API error (${res.status}): ${detail || res.statusText}`,
    );
  }
  const data = (await res.json()) as SerperResponse;
  const parts: string[] = [`Web search results for: "${query}"\n`];
  if (data.answerBox?.answer || data.answerBox?.snippet) {
    parts.push(
      `**Answer:** ${data.answerBox.answer || data.answerBox.snippet}\n`,
    );
  }
  if (data.knowledgeGraph?.title) {
    parts.push(
      `**${data.knowledgeGraph.title}:** ${data.knowledgeGraph.description || ""}\n`,
    );
  }
  for (const r of data.organic ?? []) {
    parts.push(
      `${r.position ?? "-"}. **${r.title ?? "Untitled"}**`,
      `   ${r.link ?? ""}`,
      `   ${r.snippet ?? ""}\n`,
    );
  }
  return parts.join("\n");
}

async function searchDdg(query: string): Promise<string> {
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo API error (${res.status}): ${res.statusText}`);
  }
  const data = (await res.json()) as DdgResponse;
  const parts: string[] = [`Web search results for: "${query}"\n`];
  if (data.Heading) parts.push(`**${data.Heading}**`);
  if (data.AbstractText) {
    parts.push(data.AbstractText);
    if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}\n`);
  }
  for (const topic of (data.RelatedTopics ?? []).slice(0, DEFAULT_COUNT)) {
    if (topic.Text) {
      parts.push(`- ${topic.Text}`);
      if (topic.FirstURL) parts.push(`  ${topic.FirstURL}`);
    }
  }
  if (parts.length <= 1) {
    parts.push(
      "(No instant answer available. Try a more specific query, or use web_fetch on a search engine URL.)",
    );
  }
  return parts.join("\n");
}

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results (1-10, default 5). Serper only.",
      minimum: 1,
      maximum: 10,
    }),
  ),
});

export const webSearchTool: AgentTool<typeof WebSearchParams> = {
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web. Returns titles, URLs, and snippets. " +
    "Uses Google via Serper.dev when SERPER_API_KEY is set, " +
    "otherwise falls back to DuckDuckGo.",
  parameters: WebSearchParams,

  async execute(
    _toolCallId: string,
    params: { query: string; count?: number },
  ): Promise<AgentToolResult<unknown>> {
    const query = String(params.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: "Error: empty search query." }],
        details: { error: true },
      };
    }
    const count =
      typeof params.count === "number"
        ? Math.max(1, Math.min(10, Math.floor(params.count)))
        : DEFAULT_COUNT;
    const serperKey = process.env.SERPER_API_KEY?.trim();
    try {
      const text = serperKey
        ? await searchSerper(query, serperKey, count)
        : await searchDdg(query);
      return {
        content: [{ type: "text", text }],
        details: { query, provider: serperKey ? "serper" : "ddg" },
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Web search error: ${(err as Error).message}` },
        ],
        details: { error: true },
      };
    }
  },
};
