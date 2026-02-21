import type { SlashCommand } from "@mariozechner/pi-tui";

const VERBOSE_LEVELS = ["on", "off"];
const REASONING_LEVELS = ["on", "off"];
const ELEVATED_LEVELS = ["on", "off", "ask", "full"];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_FOOTER_LEVELS = ["off", "tokens", "full"];
const THINK_LEVELS = ["on", "off"];

export type ParsedCommand = {
  name: string;
  args: string;
};

export type SlashCommandOptions = {
  provider?: string;
  model?: string;
};

const COMMAND_ALIASES: Record<string, string> = {
  elev: "elevated",
};

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) {
    return { name: "", args: "" };
  }
  const [name, ...rest] = trimmed.split(/\s+/);
  const normalized = (name ?? "").toLowerCase();
  return {
    name: COMMAND_ALIASES[normalized] ?? normalized,
    args: rest.join(" ").trim(),
  };
}

export function getSlashCommands(
  options: SlashCommandOptions = {},
): SlashCommand[] {
  void options;
  const thinkLevels = THINK_LEVELS;
  const commands: SlashCommand[] = [
    { name: "help", description: "Show slash command help" },
    { name: "model", description: "Set model (or open picker)" },
    { name: "models", description: "Open model picker" },
    {
      name: "think",
      description: "Set thinking level",
      getArgumentCompletions: (prefix: string) =>
        thinkLevels
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
    },
    {
      name: "verbose",
      description: "Set verbose on/off",
      getArgumentCompletions: (prefix: string) =>
        VERBOSE_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({
            value,
            label: value,
          }),
        ),
    },
    {
      name: "reasoning",
      description: "Set reasoning on/off",
      getArgumentCompletions: (prefix: string) =>
        REASONING_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({
            value,
            label: value,
          }),
        ),
    },
    {
      name: "usage",
      description: "Toggle per-response usage line",
      getArgumentCompletions: (prefix: string) =>
        USAGE_FOOTER_LEVELS.filter((v) =>
          v.startsWith(prefix.toLowerCase()),
        ).map((value) => ({
          value,
          label: value,
        })),
    },
    {
      name: "elevated",
      description: "Set elevated on/off/ask/full",
      getArgumentCompletions: (prefix: string) =>
        ELEVATED_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({
            value,
            label: value,
          }),
        ),
    },
    {
      name: "elev",
      description: "Alias for /elevated",
      getArgumentCompletions: (prefix: string) =>
        ELEVATED_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({
            value,
            label: value,
          }),
        ),
    },
    {
      name: "activation",
      description: "Set group activation",
      getArgumentCompletions: (prefix: string) =>
        ACTIVATION_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({
            value,
            label: value,
          }),
        ),
    },
    { name: "abort", description: "Abort active run" },
    { name: "new", description: "Reset the session" },
    { name: "reset", description: "Reset the session" },
    { name: "settings", description: "Open settings" },
    { name: "exit", description: "Exit the TUI" },
    { name: "quit", description: "Exit the TUI" },
  ];

  return commands;
}

export function helpText(_options: SlashCommandOptions = {}): string {
  const thinkLevels = THINK_LEVELS.join("|");
  return [
    "Slash commands:",
    "/help",
    "/model <provider/model> (or /models)",
    `/think <${thinkLevels}>`,
    "/verbose <on|off>",
    "/reasoning <on|off>",
    "/usage <off|tokens|full>",
    "/elevated <on|off|ask|full>",
    "/elev <on|off|ask|full>",
    "/activation <mention|always>",
    "/new or /reset",
    "/abort",
    "/settings",
    "/exit",
  ].join("\n");
}
