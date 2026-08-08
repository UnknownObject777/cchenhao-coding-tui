export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export class ToolExecutor {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  definitions(): Array<Omit<ToolDefinition, "execute">> {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `unknown tool: ${name}` };
    }
    try {
      return { ok: true, output: await tool.execute(args) };
    } catch (error) {
      return { ok: false, output: `tool ${name} failed: ${errorMessage(error)}` };
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
