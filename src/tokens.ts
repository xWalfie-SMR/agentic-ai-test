/**
 * Token persistence and lifecycle management.
 *
 * Handles reading / writing `tokens.json` and transparently refreshing
 * expired access tokens using the stored refresh token.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshAccessToken } from "./oauth.js";
import type { TokenData } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the persisted token file (project root). */
const TOKENS_PATH = resolve(__dirname, "..", "tokens.json");

/** Write token data to disk as formatted JSON. */
export function saveTokens(tokens: TokenData): void {
  writeFileSync(TOKENS_PATH, `${JSON.stringify(tokens, null, 2)}\n`, "utf-8");
}

/** Read token data from disk, returning `null` if the file is missing or corrupt. */
export function loadTokens(): TokenData | null {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, "utf-8")) as TokenData;
  } catch {
    return null;
  }
}

/**
 * Load tokens and ensure the access token is still valid.
 *
 * If the token has expired, automatically refreshes it using the stored
 * refresh token and persists the updated credentials.
 *
 * @returns Valid token data, or `null` if no tokens exist or refresh fails.
 */
export async function getValidTokens(): Promise<TokenData | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  // Token is still valid — return as-is.
  if (Date.now() < tokens.expires) {
    return tokens;
  }

  // Attempt silent refresh.
  console.log("⟳  Access token expired, refreshing…");
  try {
    const refreshed = await refreshAccessToken(tokens.refresh);
    const updated: TokenData = {
      ...tokens,
      access: refreshed.access,
      expires: refreshed.expires,
    };
    saveTokens(updated);
    console.log("✓  Token refreshed successfully.");
    return updated;
  } catch (err) {
    console.error("✗  Token refresh failed:", (err as Error).message);
    console.error("   Run `bun run auth` again to re-authenticate.");
    return null;
  }
}
