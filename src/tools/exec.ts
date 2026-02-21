/**
 * exec tool — run shell commands.
 *
 * Returns an AgentTool compatible with pi-agent-core.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 20;
  return `${text.slice(0, half)}\n\n... (${text.length - max} chars truncated) ...\n\n${text.slice(-half)}`;
}

const ExecParams = Type.Object({
  command: Type.String({ description: "The shell command to execute." }),
  workdir: Type.Optional(
    Type.String({
      description:
        "Working directory for the command. Defaults to the workspace root.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds (default: 30). The command is killed if it exceeds this.",
      minimum: 1,
      maximum: 300,
    }),
  ),
});

export const execTool: AgentTool<typeof ExecParams> = {
  name: "exec",
  label: "Run Command",
  description:
    "Run a shell command. Returns stdout, stderr, and exit code. " +
    "Use for file operations, building, testing, git, package management, etc.",
  parameters: ExecParams,

  async execute(
    _toolCallId: string,
    params: { command: string; workdir?: string; timeout?: number },
    _signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const command = String(params.command ?? "").trim();
    if (!command) {
      return {
        content: [{ type: "text", text: "Error: empty command." }],
        details: { error: true },
      };
    }

    const workdir = params.workdir ?? process.cwd();
    const timeoutMs =
      typeof params.timeout === "number"
        ? Math.min(params.timeout * 1000, 300_000)
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
      parts.push(`Exit code: ${exitCode} | ${tookMs}ms`);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { exitCode, killed },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error executing command: ${(err as Error).message}`,
          },
        ],
        details: { error: true },
      };
    }
  },
};
