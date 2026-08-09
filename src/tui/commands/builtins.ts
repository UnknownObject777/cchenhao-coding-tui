/** 内置 slash 命令注册表。新命令往这里加，声明/解析/执行保持分离。 */
import type { SlashCommandDefinition } from "./types.ts";

export function builtinCommands(): SlashCommandDefinition[] {
  return [
    {
      name: "clear",
      description: "清空对话记录与上下文",
      execute: (ctx) => ctx.clearConversation(),
    },
    {
      name: "delete",
      description: "删除当前会话的 wire 记录并清空对话",
      execute: (ctx) => ctx.deleteSession(),
    },
    {
      name: "compact",
      description: "压缩上下文：把早期对话摘要化，保留最近内容（/clear 的温和替代）",
      execute: (ctx) => ctx.compactContext(),
    },
  ];
}
