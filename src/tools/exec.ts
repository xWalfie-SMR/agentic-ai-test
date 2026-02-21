/**
 * exec tool — run shell commands.
 *
 * Adapted from OpenClaw's bash-tools.exec.ts. Uses the createExecTool()
 * factory pattern and TypeBox schema. Simplified for local CLI use
 * (no sandbox, gateway, elevated permissions, or PTY support).
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 300;
const DEFAULT_MAX_OUTPUT = 200_000;

export type ExecToolDetails = {
  status: "completed" | "failed";
  exitCode?: number;
  durationMs?: number;
  killed?: boolean;
};

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 20;
  return `${text.slice(0, half)}\n\n... (${text.length - max} chars truncated) ...\n\n${text.slice(-half)}`;
}

function clampWithDefault(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory (defaults to cwd)" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC}). The command is killed if it exceeds this.`,
      minimum: 1,
      maximum: MAX_TIMEOUT_SEC,
    }),
  ),
});

export function createExecTool(defaults?: {
  cwd?: string;
  timeoutSec?: number;
  maxOutput?: number;
  // biome-ignore lint/suspicious/noExplicitAny: matches OpenClaw's factory return type
}): AgentTool<any, ExecToolDetails> {
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : DEFAULT_TIMEOUT_SEC;
  const maxOutput =
    typeof defaults?.maxOutput === "number" && defaults.maxOutput > 0
      ? defaults.maxOutput
      : DEFAULT_MAX_OUTPUT;

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands. Returns stdout, stderr, and exit code. " +
      "Use for file operations, building, testing, git, package management, etc.",
    parameters: execSchema,
    execute: async (
      _toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<ExecToolDetails>> => {
      const params = args as {
        command: string;
        workdir?: string;
        timeout?: number;
      };

      if (!params.command?.trim()) {
        throw new Error("Provide a command to start.");
      }

      const command = params.command.trim();
      const workdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      const timeoutSec = clampWithDefault(
        params.timeout,
        defaultTimeoutSec,
        1,
        MAX_TIMEOUT_SEC,
      );
      const timeoutMs = timeoutSec * 1000;

      const startedAt = Date.now();
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

        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              if (!killed) {
                proc.kill();
              }
            },
            { once: true },
          );
        }

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        clearTimeout(timer);
        const exitCode = proc.exitCode ?? -1;
        const durationMs = Date.now() - startedAt;

        const parts: string[] = [];
        if (stdout.trim()) {
          parts.push(truncateMiddle(stdout.trim(), maxOutput));
        }
        if (stderr.trim()) {
          parts.push(`STDERR:\n${truncateMiddle(stderr.trim(), maxOutput)}`);
        }
        if (killed) {
          parts.push(`(killed: timeout after ${timeoutSec}s)`);
        }

        const exitMsg =
          exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
        const aggregated = (parts.join("\n") || "(no output)") + exitMsg;

        return {
          content: [{ type: "text", text: aggregated }],
          details: {
            status: killed ? "failed" : "completed",
            exitCode,
            durationMs,
            killed,
          },
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        return {
          content: [
            {
              type: "text",
              text: `Error executing command: ${(err as Error).message}`,
            },
          ],
          details: {
            status: "failed",
            durationMs,
          },
        };
      }
    },
  };
}

export const execTool = createExecTool();
