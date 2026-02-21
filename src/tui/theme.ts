/**
 * Terminal UI theme — OpenClaw-inspired warm palette.
 *
 * This module is TUI-specific; the API layer (api.ts, oauth.ts, tokens.ts,
 * models.ts, types.ts) remains UI-agnostic so a web frontend can reuse it.
 */

import type { EditorTheme, MarkdownTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";

// ── Palette ──────────────────────────────────────────────────────────────────

const palette = {
  text: "#E8E3D5",
  dim: "#7B7F87",
  accent: "#F6C453",
  accentSoft: "#F2A65A",
  border: "#3C414B",
  userBg: "#2B2F36",
  userText: "#F3EEE0",
  systemText: "#9BA3B2",
  quote: "#8CC8FF",
  quoteBorder: "#3B4D6B",
  code: "#F0C987",
  codeBlock: "#1E232A",
  codeBorder: "#343A45",
  link: "#7DD3A5",
  error: "#F97066",
  success: "#7DD3A5",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

// ── Syntax highlighting ──────────────────────────────────────────────────────

/** Simple cli-highlight theme mapping. */
function createSyntaxTheme(fallback: (s: string) => string) {
  return {
    keyword: chalk.hex("#C792EA"),
    built_in: chalk.hex("#82AAFF"),
    type: chalk.hex("#FFCB6B"),
    literal: chalk.hex("#F78C6C"),
    number: chalk.hex("#F78C6C"),
    string: chalk.hex("#C3E88D"),
    comment: chalk.hex("#546E7A").italic,
    doctag: chalk.hex("#82AAFF"),
    default: fallback,
  };
}

const syntaxTheme = createSyntaxTheme(fg(palette.code));

function highlightCode(code: string, lang?: string): string[] {
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    return highlighted.split("\n");
  } catch {
    return code.split("\n").map((line) => fg(palette.code)(line));
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

export const theme = {
  fg: fg(palette.text),
  assistantText: (text: string) => text,
  dim: fg(palette.dim),
  accent: fg(palette.accent),
  accentSoft: fg(palette.accentSoft),
  success: fg(palette.success),
  error: fg(palette.error),
  header: (text: string) => chalk.bold(fg(palette.accent)(text)),
  system: fg(palette.systemText),
  userBg: bg(palette.userBg),
  userText: fg(palette.userText),
  border: fg(palette.border),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(fg(palette.accent)(text)),
  link: (text) => fg(palette.link)(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => fg(palette.code)(text),
  codeBlock: (text) => fg(palette.code)(text),
  codeBlockBorder: (text) => fg(palette.codeBorder)(text),
  quote: (text) => fg(palette.quote)(text),
  quoteBorder: (text) => fg(palette.quoteBorder)(text),
  hr: (text) => fg(palette.border)(text),
  listBullet: (text) => fg(palette.accentSoft)(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode,
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg(palette.border)(text),
  selectList: {
    selectedPrefix: (text) => fg(palette.accent)(text),
    selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
    description: (text) => fg(palette.dim)(text),
    scrollInfo: (text) => fg(palette.dim)(text),
    noMatch: (text) => fg(palette.dim)(text),
  },
};
