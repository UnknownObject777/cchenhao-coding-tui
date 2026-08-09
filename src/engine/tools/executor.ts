import { truncateToolOutput } from "./truncate.ts";

/** 工具自声明的审批分类：read 自动放行；write 需确认且路径限工作区内；command 走命令 pattern 规则。 */
export type ToolApprovalKind = "read" | "write" | "command";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  /** 审批分类（approval 规则引擎的唯一工具知识来源）：缺省按 confirm 处理，不会静默放行。 */
  approval?: ToolApprovalKind;
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
      // 输出护栏统一收口（#37）：行数/字节双阈值 + [...truncated] 标记
      return { ok: true, output: truncateToolOutput(await tool.execute(args)) };
    } catch (error) {
      return { ok: false, output: truncateToolOutput(`tool ${name} failed: ${errorMessage(error)}`) };
    }
  }

  /** 工具自声明的审批分类（approval 规则引擎的单一事实来源）；未知工具返回 undefined。 */
  approvalKind(name: string): ToolApprovalKind | undefined {
    return this.tools.get(name)?.approval;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
