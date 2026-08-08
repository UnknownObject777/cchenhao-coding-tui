/**
 * 上下文窗口管理（#31/#32，#7 决策）：
 * 粗估 token = 字符数 / 4；超限滑动窗口截断——保 system + 最近消息，
 * 边界不切断 tool_call 配对（带 toolCalls 的 assistant 与其 tool 回复同进退）。
 */
import type { Message } from "./llm/types.ts";

/** kimi-for-coding 上下文 256K tokens。 */
export const CONTEXT_TOKEN_BUDGET = 256_000;
/** 估算超过预算的 80% 触发截断，截到 60% 以下（#7）。 */
export const TRUNCATE_HIGH_WATER = 0.8;
export const TRUNCATE_LOW_WATER = 0.6;

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        chars += call.name.length + JSON.stringify(call.args).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** 一组不可拆的消息：带 toolCalls 的 assistant + 紧随其后它的全部 tool 回复。 */
function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const group: Message[] = [message];
      i += 1;
      while (i < messages.length && messages[i]!.role === "tool") {
        group.push(messages[i]!);
        i += 1;
      }
      groups.push(group);
    } else {
      groups.push([message]);
      i += 1;
    }
  }
  return groups;
}

/**
 * 滑动窗口截断：system（若有）永远保留，之后从最新往回装组，装满 maxTokens 为止。
 * 返回新数组；若连 system 都超 maxTokens，原样返回（调用方走报错路径）。
 */
export function truncateToWindow(messages: Message[], maxTokens: number): Message[] {
  if (estimateTokens(messages) <= maxTokens) return messages;

  const hasSystem = messages[0]?.role === "system";
  const system = hasSystem ? [messages[0]!] : [];
  const groups = groupMessages(messages.slice(hasSystem ? 1 : 0));

  const kept: Message[][] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const candidate = [...system, ...kept.flat(), ...groups[i]!];
    if (estimateTokens(candidate) > maxTokens) break;
    kept.unshift(groups[i]!);
  }
  // 最新一组必须保留（往往是当前 prompt）；它自身超限时返回超预算结果，
  // 由调用方走「报错引导 /clear」路径（#7 最后防线）
  if (kept.length === 0 && groups.length > 0) {
    kept.unshift(groups[groups.length - 1]!);
  }
  return [...system, ...kept.flat()];
}
