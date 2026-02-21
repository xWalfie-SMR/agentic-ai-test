# Antigravity Chat

A standalone CLI for chatting with AI models (Gemini, Claude, GPT) through [Google Cloud Code Assist](https://cloud.google.com/code-assist) (Antigravity).

## Features

- **OAuth 2.0 + PKCE** — full browser-based Google sign-in flow
- **Multi-model** — dynamically fetches available models with quota info
- **Streaming responses** — real-time token-by-token output
- **System prompt** — auto-detects model identity, user distro, DE, and shell
- **Session management** — `/model`, `/clear`, `/history`, `/quit` commands

## Prerequisites

- [Bun](https://bun.sh) runtime
- A Google account with Cloud Code Assist access

## Setup

```bash
bun install
```

## Usage

### 1. Authenticate

```bash
bun run auth
```

Opens Google OAuth in your browser. Tokens are saved to `tokens.json` (gitignored).

### 2. Chat

```bash
bun run chat
```

Or with hot-reload during development:

```bash
bun run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `bun run auth` | Run the OAuth login flow |
| `bun run chat` | Start an interactive chat session |
| `bun run dev` | Chat with hot-reload (watch mode) |
| `bun run lint` | Check code with Biome |
| `bun run lint:fix` | Auto-fix lint issues |
| `bun run typecheck` | Run TypeScript type checking |

## License

[MIT](LICENSE)
