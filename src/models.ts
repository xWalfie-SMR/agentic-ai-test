/**
 * Fetch available models from the Cloud Code Assist API.
 *
 * Calls the `fetchAvailableModels` RPC to retrieve the live list of model
 * identifiers accessible to the authenticated user, along with quota info
 * (remaining fraction, reset time).
 */

import { CODE_ASSIST_BASE, FETCH_AVAILABLE_MODELS_PATH } from "./constants.js";
import type { ModelInfo } from "./types.js";

/**
 * Raw response shape from the `fetchAvailableModels` RPC.
 * @internal
 */
interface FetchAvailableModelsResponse {
  models?: Record<
    string,
    {
      displayName?: string;
      quotaInfo?: {
        remainingFraction?: number | string;
        resetTime?: string;
        isExhausted?: boolean;
      };
    }
  >;
}

/**
 * Internal model ID prefixes to exclude from the interactive picker.
 * These are IDE-internal completion / tab-completion models.
 */
const EXCLUDED_PREFIXES = ["chat_", "tab_"];

/**
 * Fetch the list of models available to the authenticated user.
 *
 * @param accessToken - Valid OAuth 2.0 access token.
 * @param projectId   - Cloud Code Assist project ID.
 * @returns Sorted array of available models (highest quota first).
 * @throws On network errors or non-2xx responses.
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<ModelInfo[]> {
  const url = `${CODE_ASSIST_BASE}${FETCH_AVAILABLE_MODELS_PATH}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity-auth/1.0",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    },
    body: JSON.stringify({ project: projectId }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch models (HTTP ${res.status}): ${body}`);
  }

  const data = (await res.json()) as FetchAvailableModelsResponse;

  if (!data.models || typeof data.models !== "object") {
    return [];
  }

  const models: ModelInfo[] = [];

  for (const [modelId, info] of Object.entries(data.models)) {
    // Skip internal models (chat_*, tab_*, etc.)
    const lower = modelId.toLowerCase();
    if (EXCLUDED_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      continue;
    }

    const remainingRaw = info.quotaInfo?.remainingFraction;
    const remainingQuota =
      remainingRaw !== undefined ? Number(remainingRaw) : undefined;

    models.push({
      id: modelId,
      displayName: info.displayName,
      remainingQuota:
        remainingQuota !== undefined && Number.isFinite(remainingQuota)
          ? remainingQuota
          : undefined,
      resetTime: info.quotaInfo?.resetTime,
    });
  }

  // Sort: highest remaining quota first, then alphabetically by ID.
  models.sort((a, b) => {
    const qa = a.remainingQuota ?? 1;
    const qb = b.remainingQuota ?? 1;
    if (qa !== qb) return qb - qa;
    return a.id.localeCompare(b.id);
  });

  return models;
}
