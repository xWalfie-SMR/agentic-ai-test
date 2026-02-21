/**
 * OAuth 2.0 and API constants for Google Antigravity (Cloud Code Assist).
 *
 * These values are extracted from the openclaw google-antigravity-auth plugin.
 * The client credentials are the same public OAuth client used by the official
 * Antigravity IDE extension — they are base64-encoded, not secret.
 */

const decode = (s: string): string => Buffer.from(s, "base64").toString();

/** Google OAuth 2.0 public client ID (decoded from base64). */
export const CLIENT_ID = decode(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);

/** Google OAuth 2.0 client secret (decoded from base64). */
export const CLIENT_SECRET = decode(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
);

/** Local redirect URI for the OAuth PKCE callback. */
export const REDIRECT_URI = "http://localhost:51121/oauth-callback";

/** Port extracted from the redirect URI. */
export const REDIRECT_PORT = 51121;

/** Google OAuth 2.0 authorization endpoint. */
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google OAuth 2.0 token endpoint. */
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Fallback Cloud Code Assist project when discovery fails. */
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

/** Cloud Code Assist API base URL. */
export const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";

/**
 * Code Assist endpoints tried in order during project ID discovery.
 * The daily sandbox is tried as a fallback if production is unavailable.
 */
export const CODE_ASSIST_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const;

/** Path for the loadCodeAssist RPC (credits, plan info, project ID). */
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";

/** Path for the fetchAvailableModels RPC (live model list with quotas). */
export const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

/**
 * OAuth scopes required for Antigravity access.
 *
 * - `cloud-platform`: access to Google Cloud APIs (Vertex AI / Code Assist)
 * - `userinfo.email` / `userinfo.profile`: identify the signed-in user
 * - `cclog`: Cloud Code logging
 * - `experimentsandconfigs`: feature flag / experiment access
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;

/**
 * Grace period (in ms) subtracted from `expires_in` to avoid using a token
 * right at the boundary of its validity window.
 */
export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
