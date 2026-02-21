/**
 * web_search tool — search the web.
 *
 * Adapted from OpenClaw's web-search.ts. Supports Brave, Perplexity, Grok,
 * and DuckDuckGo (free, no key) providers. Provider selection and API keys
 * are resolved from environment variables (no OpenClawConfig dependency).
 */

import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  type CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["brave", "perplexity", "grok", "duckduckgo"] as const;
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description:
        "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. Brave supports 'pd', 'pw', 'pm', 'py', and date range 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity supports 'pd', 'pw', 'pm', and 'py'.",
    }),
  ),
});

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

function normalizeSecretInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (
          block.type === "output_text" &&
          typeof block.text === "string" &&
          block.text
        ) {
          const urls = (block.annotations ?? [])
            .filter(
              (a) => a.type === "url_citation" && typeof a.url === "string",
            )
            .map((a) => a.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const rawAnnotations =
        "annotations" in output && Array.isArray(output.annotations)
          ? output.annotations
          : [];
      const urls = rawAnnotations
        .filter(
          (a: Record<string, unknown>) =>
            a.type === "url_citation" && typeof a.url === "string",
        )
        .map((a: Record<string, unknown>) => a.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }
  const text =
    typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

function resolveSearchProvider(): (typeof SEARCH_PROVIDERS)[number] {
  const raw = (process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "perplexity") return "perplexity";
  if (raw === "grok") return "grok";
  if (raw === "brave") return "brave";
  if (raw === "duckduckgo" || raw === "ddg") return "duckduckgo";
  // Auto-detect from available API keys
  if (normalizeSecretInput(process.env.BRAVE_API_KEY)) return "brave";
  if (
    normalizeSecretInput(process.env.PERPLEXITY_API_KEY) ||
    normalizeSecretInput(process.env.OPENROUTER_API_KEY)
  )
    return "perplexity";
  if (normalizeSecretInput(process.env.XAI_API_KEY)) return "grok";
  // Default: DuckDuckGo (free, no API key required)
  return "duckduckgo";
}

function resolveSearchApiKey(): string | undefined {
  return normalizeSecretInput(process.env.BRAVE_API_KEY) || undefined;
}

function resolvePerplexityApiKey(): {
  apiKey?: string;
  source: "perplexity_env" | "openrouter_env" | "none";
} {
  const fromEnvPerplexity = normalizeSecretInput(
    process.env.PERPLEXITY_API_KEY,
  );
  if (fromEnvPerplexity)
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  const fromEnvOpenRouter = normalizeSecretInput(
    process.env.OPENROUTER_API_KEY,
  );
  if (fromEnvOpenRouter)
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  return { apiKey: undefined, source: "none" };
}

function inferPerplexityBaseUrlFromApiKey(
  apiKey?: string,
): PerplexityBaseUrlHint | undefined {
  if (!apiKey) return undefined;
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix)))
    return "direct";
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix)))
    return "openrouter";
  return undefined;
}

function resolvePerplexityBaseUrl(
  apiKeySource: "perplexity_env" | "openrouter_env" | "none",
  apiKey?: string,
): string {
  if (apiKeySource === "perplexity_env") return PERPLEXITY_DIRECT_BASE_URL;
  if (apiKeySource === "openrouter_env") return DEFAULT_PERPLEXITY_BASE_URL;
  const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
  if (inferred === "direct") return PERPLEXITY_DIRECT_BASE_URL;
  if (inferred === "openrouter") return DEFAULT_PERPLEXITY_BASE_URL;
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(): string {
  return (
    normalizeSecretInput(process.env.PERPLEXITY_MODEL) ||
    DEFAULT_PERPLEXITY_MODEL
  );
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) return model;
  return model.startsWith("perplexity/")
    ? model.slice("perplexity/".length)
    : model;
}

function resolveGrokApiKey(): string | undefined {
  return normalizeSecretInput(process.env.XAI_API_KEY) || undefined;
}

function resolveGrokModel(): string {
  return normalizeSecretInput(process.env.GROK_MODEL) || DEFAULT_GROK_MODEL;
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return lower;
  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) return undefined;
  const start = match[1] ?? "";
  const end = match[2] ?? "";
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return undefined;
  if (start > end) return undefined;
  return `${start}to${end}`;
}

function freshnessToPerplexityRecency(
  freshness: string | undefined,
): string | undefined {
  if (!freshness) return undefined;
  const map: Record<string, string> = {
    pd: "day",
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-");
  const year = Number.parseInt(parts[0] ?? "", 10);
  const month = Number.parseInt(parts[1] ?? "", 10);
  const day = Number.parseInt(parts[2] ?? "", 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  )
    return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY.",
    };
  }
  if (provider === "grok") {
    return {
      error: "missing_xai_api_key",
      message: "web_search (grok) needs an xAI API key. Set XAI_API_KEY.",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: "web_search needs a Brave Search API key. Set BRAVE_API_KEY.",
  };
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: params.query }],
  };

  const recencyFilter = freshnessToPerplexityRecency(params.freshness);
  if (recencyFilter) {
    body.search_recency_filter = recencyFilter;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(
      `Perplexity API error (${res.status}): ${detailResult.text || res.statusText}`,
    );
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];
  return { content, citations };
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [{ role: "user", content: params.query }],
    tools: [{ type: "web_search" }],
  };

  const res = await fetch(XAI_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(
      `xAI API error (${res.status}): ${detailResult.text || res.statusText}`,
    );
  }

  const data = (await res.json()) as GrokSearchResponse;
  const { text: extractedText, annotationCitations } = extractGrokContent(data);
  const content = extractedText ?? "No response";
  const citations =
    (data.citations ?? []).length > 0
      ? (data.citations ?? [])
      : annotationCitations;
  return { content, citations, inlineCitations: data.inline_citations };
}

function parseDdgHtml(
  html: string,
  count: number,
): Array<{ title: string; url: string; description: string }> {
  const results: Array<{ title: string; url: string; description: string }> =
    [];
  // Match each result block
  const resultBlocks = html.match(
    /<div class="result[^"]*results_links[^"]*">[\s\S]*?<\/div>\s*<\/div>/gi,
  );
  if (!resultBlocks) return results;
  for (const block of resultBlocks) {
    if (results.length >= count) break;
    // Extract URL from the result link
    const urlMatch = block.match(
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"/i,
    );
    // Extract title text
    const titleMatch = block.match(
      /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i,
    );
    // Extract snippet
    const snippetMatch = block.match(
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const rawUrl = urlMatch?.[1] ?? "";
    const title = (titleMatch?.[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .trim();
    const description = (snippetMatch?.[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .trim();
    // DDG HTML wraps external URLs in a redirect — extract the actual URL
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl, "https://duckduckgo.com");
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) url = decodeURIComponent(uddg);
    } catch {
      // keep rawUrl
    }
    if (url && title) {
      results.push({ title, url, description });
    }
  }
  return results;
}

async function runDdgSearch(params: {
  query: string;
  count: number;
  timeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ q: params.query });
  const res = await fetch(DDG_HTML_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": DDG_USER_AGENT,
    },
    body: body.toString(),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(
      `DuckDuckGo search error (${res.status}): ${detailResult.text || res.statusText}`,
    );
  }
  const html = await res.text();
  const results = parseDdgHtml(html, params.count);
  return {
    query: params.query,
    provider: "duckduckgo",
    count: results.length,
    results: results.map((r) => ({
      ...r,
      siteName: resolveSiteName(r.url) || undefined,
    })),
  };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey?: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  grokModel?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    params.provider === "duckduckgo"
      ? `ddg:${params.query}:${params.count}`
      : params.provider === "brave"
        ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
        : params.provider === "perplexity"
          ? `${params.provider}:${params.query}:${params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}:${params.freshness || "default"}`
          : `${params.provider}:${params.query}:${params.grokModel ?? DEFAULT_GROK_MODEL}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  if (params.provider === "duckduckgo") {
    const result = await runDdgSearch({
      query: params.query,
      count: params.count,
      timeoutSeconds: params.timeoutSeconds,
    });
    const payload = { ...result, tookMs: Date.now() - start };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "perplexity") {
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey ?? "",
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
    });
    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      content,
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const { content, citations, inlineCitations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey ?? "",
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });
    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      tookMs: Date.now() - start,
      content,
      citations,
      inlineCitations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave" || !params.apiKey) {
    throw new Error("Unsupported web search provider or missing API key.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) url.searchParams.set("country", params.country);
  if (params.search_lang)
    url.searchParams.set("search_lang", params.search_lang);
  if (params.ui_lang) url.searchParams.set("ui_lang", params.ui_lang);
  if (params.freshness) url.searchParams.set("freshness", params.freshness);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey ?? "",
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(
      `Brave Search API error (${res.status}): ${detailResult.text || res.statusText}`,
    );
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results)
    ? (data.web?.results ?? [])
    : [];
  const mapped = results.map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    description: entry.description ?? "",
    published: entry.age || undefined,
    siteName: resolveSiteName(entry.url) || undefined,
  }));

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(): AnyAgentTool | null {
  const provider = resolveSearchProvider();
  const description =
    provider === "duckduckgo"
      ? "Search the web using DuckDuckGo. Returns titles, URLs, and snippets. No API key required."
      : provider === "perplexity"
        ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
        : provider === "grok"
          ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
          : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const perplexityAuth =
        provider === "perplexity" ? resolvePerplexityApiKey() : undefined;
      const apiKey =
        provider === "duckduckgo"
          ? undefined
          : provider === "perplexity"
            ? perplexityAuth?.apiKey
            : provider === "grok"
              ? resolveGrokApiKey()
              : resolveSearchApiKey();

      if (!apiKey && provider !== "duckduckgo") {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count = readNumberParam(params, "count", { integer: true });
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && provider !== "brave" && provider !== "perplexity") {
        return jsonResult({
          error: "unsupported_freshness",
          message:
            "freshness is only supported by the Brave and Perplexity web_search providers.",
        });
      }
      const freshness = rawFreshness
        ? normalizeFreshness(rawFreshness)
        : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
        });
      }
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(
          undefined,
          DEFAULT_TIMEOUT_SECONDS,
        ),
        cacheTtlMs: resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        search_lang,
        ui_lang,
        freshness,
        perplexityBaseUrl: resolvePerplexityBaseUrl(
          perplexityAuth?.source ?? "none",
          perplexityAuth?.apiKey,
        ),
        perplexityModel: resolvePerplexityModel(),
        grokModel: resolveGrokModel(),
      });
      return jsonResult(result);
    },
  };
}
