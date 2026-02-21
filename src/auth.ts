#!/usr/bin/env bun

/**
 * Interactive Google Antigravity OAuth login.
 *
 * Performs a full OAuth 2.0 Authorization Code + PKCE flow:
 *
 *   1. Generates a PKCE verifier/challenge pair and a random state nonce.
 *   2. Starts a local HTTP server on port 51121 to receive the redirect.
 *   3. Opens the Google sign-in page in the user's default browser.
 *   4. Waits for the authorization callback, validates state, and exchanges
 *      the code for access + refresh tokens.
 *   5. Fetches the user's email and Cloud Code Assist project ID.
 *   6. Persists everything to `tokens.json` for use by other scripts.
 *
 * Usage:
 *   bun run auth
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import color from "picocolors";
import {
  buildAuthUrl,
  exchangeCode,
  fetchProjectId,
  fetchUserEmail,
  generatePkce,
  startCallbackServer,
} from "./oauth.js";
import { saveTokens } from "./tokens.js";
import type { TokenData } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Attempt to open a URL in the user's default browser. */
function openInBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      execSync(
        `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || true`,
      );
    }
  } catch {
    // Non-fatal — the user can copy-paste the URL manually.
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  p.intro(color.bgCyan(color.black(" Antigravity OAuth Login ")));

  // 1. Generate PKCE + state
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(challenge, state);

  // 2. Start the local callback server
  const spin = p.spinner();
  let callbackServer:
    | Awaited<ReturnType<typeof startCallbackServer>>
    | undefined;

  try {
    spin.start("Starting callback server…");
    callbackServer = await startCallbackServer();
    spin.stop("Callback server ready on localhost:51121");
  } catch (err) {
    spin.stop("Failed to start callback server");
    p.log.error(`${(err as Error).message}`);
    p.log.message("Open this URL manually in your browser:");
    p.log.message(color.underline(authUrl));
    p.outro("Could not start callback server.");
    process.exit(1);
  }

  // 3. Open the browser
  p.log.step("Opening Google sign-in in your browser…");
  openInBrowser(authUrl);
  p.log.message(color.dim("If the browser didn't open, copy this URL:"));
  p.log.message(color.dim(color.underline(authUrl)));

  // 4. Wait for the OAuth callback
  spin.start("Waiting for OAuth callback…");
  const callbackUrl = await callbackServer.waitForCallback();
  const code = callbackUrl.searchParams.get("code");
  const returnedState = callbackUrl.searchParams.get("state");
  await callbackServer.close();

  if (!code) {
    spin.stop("No authorization code received");
    p.outro("Login failed.");
    process.exit(1);
  }
  if (returnedState !== state) {
    spin.stop("OAuth state mismatch — possible CSRF");
    p.outro("Login failed. Please try again.");
    process.exit(1);
  }
  spin.stop("Authorization code received");

  // 5. Exchange the code for tokens
  spin.start("Exchanging code for tokens…");
  const tokens = await exchangeCode(code, verifier);
  spin.stop("Access and refresh tokens obtained");

  // 6. Fetch user email
  spin.start("Fetching user info…");
  const email = await fetchUserEmail(tokens.access);
  spin.stop(`Authenticated as ${color.cyan(email ?? "(unknown)")}`);

  // 7. Resolve Cloud Code Assist project
  spin.start("Resolving Cloud Code Assist project…");
  const projectId = await fetchProjectId(tokens.access);
  spin.stop(`Project: ${color.cyan(projectId)}`);

  // 8. Persist tokens
  const tokenData: TokenData = { ...tokens, email, projectId };
  saveTokens(tokenData);

  p.log.success("Credentials saved to tokens.json");
  p.outro(`Run ${color.cyan("bun run chat")} to start chatting with Claude.`);
}

main().catch((err) => {
  p.log.error(`Login failed: ${(err as Error).message}`);
  process.exit(1);
});
