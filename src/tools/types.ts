/**
 * Tool definition and execution types.
 *
 * Each tool has a Gemini-compatible schema and an execute function.
 */

/** JSON Schema subset for Gemini function declarations. */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description: string;
      enum?: string[];
      minimum?: number;
      maximum?: number;
    }
  >;
  required?: string[];
}

/** A tool that the AI can call. */
export interface Tool {
  /** Tool name (used in function declarations). */
  name: string;
  /** Human-readable description for the AI. */
  description: string;
  /** JSON Schema for parameters. */
  parameters: ToolParameterSchema;
  /** Execute the tool and return a result string. */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/** Result returned by a tool execution. */
export interface ToolResult {
  /** Human-readable output shown to the AI. */
  output: string;
  /** If true, the tool encountered an error. */
  error?: boolean;
}

/** Gemini functionDeclarations format. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/** Convert Tool[] to Gemini functionDeclarations. */
export function toFunctionDeclarations(
  tools: Tool[],
): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}
