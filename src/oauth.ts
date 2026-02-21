/**
 * OAuth 2.0 operations for Google Antigravity.
 *
 * Implements PKCE code generation, local callback server, authorization code
 * exchange, token refresh, and post-login enrichment (email + project ID).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  AUTH_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  CODE_ASSIST_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  REDIRECT_PORT,
  REDIRECT_URI,
  SCOPES,
  TOKEN_EXPIRY_BUFFER_MS,
  TOKEN_URL,
} from "./constants.js";
import type {
  PkceParams,
  TokenExchangeResult,
  TokenRefreshResult,
} from "./types.js";

// ── PKCE ─────────────────────────────────────────────────────────────────────

/** Generate a PKCE verifier + S256 challenge pair. */
export function generatePkce(): PkceParams {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Build the full Google OAuth authorization URL with PKCE params. */
export function buildAuthUrl(challenge: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

// ── Local callback server ────────────────────────────────────────────────────

/** HTML page served after the OAuth redirect completes. */
const CALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Antigravity OAuth</title></head>
  <body>
    <main>
      <h1>Authentication complete ✓</h1>
      <p>You can close this tab and return to the terminal.</p>
    </main>
  </body>
</html>`;

export interface CallbackServer {
  /** Resolves with the full callback URL once Google redirects back. */
  waitForCallback: () => Promise<URL>;
  /** Gracefully shut down the HTTP server. */
  close: () => Promise<void>;
}

/**
 * Start a local HTTP server on {@link REDIRECT_PORT} to capture the OAuth
 * callback. Times out after `timeoutMs` milliseconds.
 */
export function startCallbackServer(
  timeoutMs = 5 * 60 * 1000,
): Promise<CallbackServer> {
  return new Promise<CallbackServer>((resolveServer, rejectServer) => {
    let settled = false;
    let resolveCallback!: (url: URL) => void;
    let rejectCallback!: (err: Error) => void;

    const callbackPromise = new Promise<URL>((resolve, reject) => {
      resolveCallback = (url: URL) => {
        if (settled) return;
        settled = true;
        resolve(url);
      };
      rejectCallback = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
    });

    const timeout = setTimeout(() => {
      rejectCallback(new Error("Timed out waiting for OAuth callback"));
    }, timeoutMs);
    timeout.unref();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing URL");
        return;
      }

      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CALLBACK_HTML);
      resolveCallback(url);

      setImmediate(() => server.close());
    });

    server.once("error", (err: Error) => rejectServer(err));
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolveServer({
        waitForCallback: () => callbackPromise,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── Token exchange & refresh ─────────────────────────────────────────────────

/**
 * Exchange an authorization code + PKCE verifier for access & refresh tokens.
 *
 * @throws If the token endpoint returns an error or missing tokens.
 */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<TokenExchangeResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  if (!access) throw new Error("Token exchange returned no access_token");
  if (!refresh) throw new Error("Token exchange returned no refresh_token");

  const expiresIn = data.expires_in ?? 0;
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS,
  };
}

/**
 * Use a refresh token to obtain a new access token.
 *
 * @throws If the refresh endpoint returns an error.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenRefreshResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  const access = data.access_token?.trim();
  if (!access) throw new Error("Token refresh returned no access_token");

  const expiresIn = data.expires_in ?? 0;
  return {
    access,
    expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS,
  };
}

// ── Post-login enrichment ────────────────────────────────────────────────────

/** Fetch the authenticated user's email address from the Google userinfo API. */
export async function fetchUserEmail(
  accessToken: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Cloud Code Assist companion project ID.
 *
 * Tries the production and daily-sandbox endpoints in order, falling back to
 * {@link DEFAULT_PROJECT_ID} if none respond.
 */
export async function fetchProjectId(accessToken: string): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };

  const body = JSON.stringify({
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });

  for (const endpoint of CODE_ASSIST_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body,
      });
      if (!res.ok) continue;

      const data = (await res.json()) as {
        cloudaicompanionProject?: string | { id?: string };
      };

      if (typeof data.cloudaicompanionProject === "string") {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject === "object" &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id;
      }
    } catch {
      // Try next endpoint
    }
  }

  return DEFAULT_PROJECT_ID;
}
