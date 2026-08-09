/**
 * slash 命令契约：声明 / 解析 / 执行分离（对齐 kimi-code commands/ 目录的迷你版）。
 * 命令能碰的能力收敛在 SlashCommandContext 里，不直接拿 coordinator。
 */
export interface SlashCommandContext {
  /** 清空对话（UI transcript + 引擎上下文）。 */
  clearConversation(): void;
  /** 删除当前会话 wire 记录并清空对话。 */
  deleteSession(): Promise<void>;
  /** 压缩上下文（#57）：摘要早期对话、保留最近内容；不动 transcript。 */
  compactContext(): Promise<void>;
}

export interface SlashCommandDefinition {
  /** 不含斜杠，如 "clear"。 */
  name: string;
  description: string;
  execute(ctx: SlashCommandContext): void | Promise<void>;
}
