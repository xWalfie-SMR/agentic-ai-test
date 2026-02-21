/**
 * exec tool — run shell commands.
 *
 * Executes commands via the user's default shell with stdout/stderr
 * capture and timeout support.
 */

import type { Tool, ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 20;
  return `${text.slice(0, half)}\n\n... (${text.length - max} chars truncated) ...\n\n${text.slice(-half)}`;
}

export const execTool: Tool = {
  name: "exec",
  description:
    "Run a shell command. Returns stdout, stderr, and exit code. " +
    "Use for file operations, building, testing, git, package management, etc.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
      workdir: {
        type: "string",
        description:
          "Working directory for the command. Defaults to the workspace root.",
      },
      timeout: {
        type: "number",
        description:
          "Timeout in seconds (default: 30). The command is killed if it exceeds this.",
        minimum: 1,
        maximum: 300,
      },
    },
    required: ["command"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command.trim()) {
      return { output: "Error: empty command.", error: true };
    }

    const workdir = args.workdir ? String(args.workdir) : process.cwd();
    const timeoutMs =
      typeof args.timeout === "number"
        ? Math.min(args.timeout * 1000, 300_000)
        : DEFAULT_TIMEOUT_MS;

    const start = Date.now();
    let killed = false;

    try {
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb" },
      });

      // Timeout handling
      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, timeoutMs);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timer);
      const exitCode = proc.exitCode ?? -1;
      const tookMs = Date.now() - start;

      const parts: string[] = [];
      if (stdout.trim()) {
        parts.push(truncateMiddle(stdout.trim(), MAX_OUTPUT_CHARS));
      }
      if (stderr.trim()) {
        parts.push(
          `STDERR:\n${truncateMiddle(stderr.trim(), MAX_OUTPUT_CHARS)}`,
        );
      }
      if (killed) {
        parts.push(`(killed: timeout after ${Math.round(timeoutMs / 1000)}s)`);
      }

      const status = `Exit code: ${exitCode} | ${tookMs}ms`;
      parts.push(status);

      return {
        output: parts.join("\n"),
        error: exitCode !== 0,
      };
    } catch (err) {
      return {
        output: `Error executing command: ${(err as Error).message}`,
        error: true,
      };
    }
  },
};
