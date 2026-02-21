/**
 * Shared type definitions for the Antigravity auth project.
 */

/** Persisted token state written to / read from `tokens.json`. */
export interface TokenData {
  /** OAuth 2.0 access token (short-lived). */
  access: string;

  /** OAuth 2.0 refresh token (long-lived, used to mint new access tokens). */
  refresh: string;

  /**
   * Timestamp (epoch ms) after which the access token should be considered
   * expired. Includes a 5-minute safety buffer.
   */
  expires: number;

  /** Google account email address of the authenticated user. */
  email?: string;

  /** Cloud Code Assist project ID resolved during login. */
  projectId: string;
}

/** Successful PKCE parameter pair. */
export interface PkceParams {
  /** Random hex verifier string. */
  verifier: string;

  /** Base64url-encoded SHA-256 hash of the verifier. */
  challenge: string;
}

/** Result of the OAuth token exchange. */
export interface TokenExchangeResult {
  access: string;
  refresh: string;
  expires: number;
}

/** Result of an access token refresh. */
export interface TokenRefreshResult {
  access: string;
  expires: number;
}

/** A model available through Cloud Code Assist, with quota info. */
export interface ModelInfo {
  /** Full model identifier (e.g. "claude-sonnet-4-5-20250514"). */
  id: string;

  /** Human-readable display name from the API. */
  displayName?: string;

  /** Fraction of quota remaining, 0.0–1.0. */
  remainingQuota?: number;

  /** ISO 8601 timestamp when the quota resets. */
  resetTime?: string;
}

/** A single message in a conversation history. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Token usage counters returned after a completion. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
