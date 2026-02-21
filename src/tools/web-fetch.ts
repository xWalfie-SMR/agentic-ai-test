/**
 * web_fetch tool — fetch and extract readable content from a URL.
 *
 * Adapted from OpenClaw's web-fetch.ts. Supports Readability-based content
 * extraction and optional Firecrawl fallback. Config resolved from environment
 * variables (no OpenClawConfig dependency).
 */

import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  type ExtractMode,
  extractReadableContent,
  htmlToMarkdown,
  markdownToText,
  truncateText,
} from "./web-fetch-utils.js";
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

export { extractReadableContent } from "./web-fetch-utils.js";

const EXTRACT_MODES = ["markdown", "text"] as const;

const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  extractMode: Type.Optional(
    Type.Union(
      EXTRACT_MODES.map((m) => Type.Literal(m)),
      {
        description: 'Extraction mode ("markdown" or "text").',
        default: "markdown",
      },
    ),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded).",
      minimum: 100,
    }),
  ),
});

type FirecrawlFetchConfig = {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  timeoutSeconds: number;
};

type WebFetchRuntimeParams = {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
  maxResponseBytes: number;
  maxRedirects: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
  readabilityEnabled: boolean;
  firecrawl: FirecrawlFetchConfig;
};

function normalizeSecretInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed) return false;
  const head = trimmed.slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType, maxChars } = params;
  if (!detail) return "";
  let text = detail;
  const contentTypeLower = contentType?.toLowerCase();
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title
      ? `${rendered.title}\n${rendered.text}`
      : rendered.text;
    text = markdownToText(withTitle);
  }
  const truncated = truncateText(text.trim(), maxChars);
  return truncated.text;
}

function normalizeContentType(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const [raw] = value.split(";");
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function resolveMaxChars(
  value: unknown,
  fallback: number,
  cap: number,
): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(100, Math.floor(parsed));
  return Math.min(clamped, cap);
}

function resolveMaxRedirects(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(parsed));
}

function resolveFirecrawlEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  try {
    const url = new URL(trimmed);
    if (url.pathname && url.pathname !== "/") return url.toString();
    url.pathname = "/v2/scrape";
    return url.toString();
  } catch {
    return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  }
}

function resolveFirecrawlConfig(): FirecrawlFetchConfig {
  const apiKey =
    normalizeSecretInput(process.env.FIRECRAWL_API_KEY) || undefined;
  return {
    enabled: Boolean(apiKey),
    apiKey,
    baseUrl:
      normalizeSecretInput(process.env.FIRECRAWL_BASE_URL) ||
      DEFAULT_FIRECRAWL_BASE_URL,
    onlyMainContent: true,
    maxAgeMs: DEFAULT_FIRECRAWL_MAX_AGE_MS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
}

async function fetchFirecrawlContent(params: {
  url: string;
  extractMode: ExtractMode;
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  timeoutSeconds: number;
}): Promise<{
  text: string;
  title?: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
}> {
  const endpoint = resolveFirecrawlEndpoint(params.baseUrl);
  const body: Record<string, unknown> = {
    url: params.url,
    formats: ["markdown"],
    onlyMainContent: params.onlyMainContent,
    timeout: params.timeoutSeconds * 1000,
    maxAge: params.maxAgeMs,
    proxy: "auto",
    storeInCache: true,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  const payload = (await res.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      content?: string;
      metadata?: {
        title?: string;
        sourceURL?: string;
        statusCode?: number;
      };
    };
    warning?: string;
    error?: string;
  };

  if (!res.ok || payload?.success === false) {
    const detail = payload?.error ?? "";
    throw new Error(
      `Firecrawl fetch failed (${res.status}): ${detail || res.statusText}`.trim(),
    );
  }

  const data = payload?.data ?? {};
  const rawText =
    typeof data.markdown === "string"
      ? data.markdown
      : typeof data.content === "string"
        ? data.content
        : "";
  const text =
    params.extractMode === "text" ? markdownToText(rawText) : rawText;
  return {
    text,
    title: data.metadata?.title,
    finalUrl: data.metadata?.sourceURL,
    status: data.metadata?.statusCode,
    warning: payload?.warning,
  };
}

async function tryFirecrawlFallback(
  fc: FirecrawlFetchConfig,
  url: string,
  extractMode: ExtractMode,
): Promise<{ text: string; title?: string } | null> {
  if (!fc.enabled || !fc.apiKey) return null;
  try {
    const result = await fetchFirecrawlContent({
      url,
      extractMode,
      apiKey: fc.apiKey,
      baseUrl: fc.baseUrl,
      onlyMainContent: fc.onlyMainContent,
      maxAgeMs: fc.maxAgeMs,
      timeoutSeconds: fc.timeoutSeconds,
    });
    return { text: result.text, title: result.title };
  } catch {
    return null;
  }
}

async function maybeFetchFirecrawlPayload(params: {
  fc: FirecrawlFetchConfig;
  rawUrl: string;
  finalUrl: string;
  statusFallback: number;
  extractMode: ExtractMode;
  maxChars: number;
  cacheTtlMs: number;
  cacheKey: string;
  tookMs: number;
}): Promise<Record<string, unknown> | null> {
  if (!params.fc.enabled || !params.fc.apiKey) return null;
  const firecrawl = await fetchFirecrawlContent({
    url: params.finalUrl,
    extractMode: params.extractMode,
    apiKey: params.fc.apiKey,
    baseUrl: params.fc.baseUrl,
    onlyMainContent: params.fc.onlyMainContent,
    maxAgeMs: params.fc.maxAgeMs,
    timeoutSeconds: params.fc.timeoutSeconds,
  });
  const truncated = truncateText(firecrawl.text, params.maxChars);
  const payload: Record<string, unknown> = {
    url: params.rawUrl,
    finalUrl: firecrawl.finalUrl || params.finalUrl,
    status: firecrawl.status ?? params.statusFallback,
    contentType: "text/markdown",
    title: firecrawl.title,
    extractMode: params.extractMode,
    extractor: "firecrawl",
    truncated: truncated.truncated,
    length: truncated.text.length,
    fetchedAt: new Date().toISOString(),
    tookMs: params.tookMs,
    text: truncated.text,
    warning: firecrawl.warning,
  };
  writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function followRedirects(
  url: string,
  maxRedirects: number,
  init: RequestInit,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  let redirectCount = 0;
  while (true) {
    const res = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (
      redirectCount < maxRedirects &&
      (res.status === 301 ||
        res.status === 302 ||
        res.status === 303 ||
        res.status === 307 ||
        res.status === 308)
    ) {
      const location = res.headers.get("location");
      if (location) {
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount++;
        continue;
      }
    }
    return { response: res, finalUrl: currentUrl };
  }
}

async function runWebFetch(
  params: WebFetchRuntimeParams,
): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }

  const start = Date.now();
  let res: Response;
  let finalUrl = params.url;
  try {
    const result = await followRedirects(params.url, params.maxRedirects, {
      headers: {
        Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
        "User-Agent": params.userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: withTimeout(undefined, params.timeoutSeconds * 1000),
    });
    res = result.response;
    finalUrl = result.finalUrl;
  } catch (error) {
    const payload = await maybeFetchFirecrawlPayload({
      fc: params.firecrawl,
      rawUrl: params.url,
      finalUrl,
      statusFallback: 200,
      extractMode: params.extractMode,
      maxChars: params.maxChars,
      cacheTtlMs: params.cacheTtlMs,
      cacheKey,
      tookMs: Date.now() - start,
    }).catch(() => null);
    if (payload) return payload;
    throw error;
  }

  if (!res.ok) {
    const payload = await maybeFetchFirecrawlPayload({
      fc: params.firecrawl,
      rawUrl: params.url,
      finalUrl,
      statusFallback: res.status,
      extractMode: params.extractMode,
      maxChars: params.maxChars,
      cacheTtlMs: params.cacheTtlMs,
      cacheKey,
      tookMs: Date.now() - start,
    }).catch(() => null);
    if (payload) return payload;
    const rawDetailResult = await readResponseText(res, {
      maxBytes: DEFAULT_ERROR_MAX_BYTES,
    });
    const detail = formatWebFetchErrorDetail({
      detail: rawDetailResult.text,
      contentType: res.headers.get("content-type"),
      maxChars: DEFAULT_ERROR_MAX_CHARS,
    });
    throw new Error(
      `Web fetch failed (${res.status}): ${detail || res.statusText}`,
    );
  }

  const contentType =
    res.headers.get("content-type") ?? "application/octet-stream";
  const normalizedContentType =
    normalizeContentType(contentType) ?? "application/octet-stream";
  const bodyResult = await readResponseText(res, {
    maxBytes: params.maxResponseBytes,
  });
  const body = bodyResult.text;
  const responseTruncatedWarning = bodyResult.truncated
    ? `Response body truncated after ${params.maxResponseBytes} bytes.`
    : undefined;

  let title: string | undefined;
  let extractor = "raw";
  let text = body;
  if (contentType.includes("text/markdown")) {
    extractor = "cf-markdown";
    if (params.extractMode === "text") {
      text = markdownToText(body);
    }
  } else if (contentType.includes("text/html")) {
    if (params.readabilityEnabled) {
      const readable = await extractReadableContent({
        html: body,
        url: finalUrl,
        extractMode: params.extractMode,
      });
      if (readable?.text) {
        text = readable.text;
        title = readable.title;
        extractor = "readability";
      } else {
        const firecrawl = await tryFirecrawlFallback(
          params.firecrawl,
          finalUrl,
          params.extractMode,
        );
        if (firecrawl) {
          text = firecrawl.text;
          title = firecrawl.title;
          extractor = "firecrawl";
        } else {
          const fallback = htmlToMarkdown(body);
          text =
            params.extractMode === "text"
              ? markdownToText(fallback.text)
              : fallback.text;
          title = fallback.title;
          extractor = "html-to-markdown";
        }
      }
    } else {
      const fallback = htmlToMarkdown(body);
      text =
        params.extractMode === "text"
          ? markdownToText(fallback.text)
          : fallback.text;
      title = fallback.title;
      extractor = "html-to-markdown";
    }
  } else if (contentType.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
      extractor = "json";
    } catch {
      text = body;
      extractor = "raw";
    }
  }

  const truncated = truncateText(text, params.maxChars);
  const payload: Record<string, unknown> = {
    url: params.url,
    finalUrl,
    status: res.status,
    contentType: normalizedContentType,
    title,
    extractMode: params.extractMode,
    extractor,
    truncated: truncated.truncated,
    length: truncated.text.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
    text: truncated.text,
    warning: responseTruncatedWarning,
  };
  writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebFetchTool(): AnyAgentTool | null {
  const firecrawl = resolveFirecrawlConfig();
  return {
    label: "Web Fetch",
    name: "web_fetch",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation.",
    parameters: WebFetchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const extractMode =
        readStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readNumberParam(params, "maxChars", { integer: true });
      const result = await runWebFetch({
        url,
        extractMode,
        maxChars: resolveMaxChars(
          maxChars,
          DEFAULT_FETCH_MAX_CHARS,
          DEFAULT_FETCH_MAX_CHARS,
        ),
        maxResponseBytes: DEFAULT_FETCH_MAX_RESPONSE_BYTES,
        maxRedirects: resolveMaxRedirects(
          undefined,
          DEFAULT_FETCH_MAX_REDIRECTS,
        ),
        timeoutSeconds: resolveTimeoutSeconds(
          undefined,
          DEFAULT_TIMEOUT_SECONDS,
        ),
        cacheTtlMs: resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
        userAgent: DEFAULT_FETCH_USER_AGENT,
        readabilityEnabled: true,
        firecrawl,
      });
      return jsonResult(result);
    },
  };
}
