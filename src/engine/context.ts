/**
 * 上下文窗口管理（#31/#32，#7 决策，#57 扩展为真压缩）：
 * 粗估 token = 字符数 / 4。超 80% 预算时先 compaction（LLM 摘要替换旧消息 +
 * 保留最近尾部，整组不拆 tool 配对；见 loop.ts 的触发与摘要调用），
 * 摘要失败退化为滑动窗口截断；本文件的纯函数同时供 wire 冷重建复用，
 * 保证压缩点重建上下文 == 压缩后状态。
 */
import type { Message } from "./llm/types.ts";

/** 默认上下文预算（kimi-for-coding 现状 256K tokens）；可经配置 context_budget 覆盖（config.ts）。不做 provider 自动换算表：换 provider 沿用此默认值，按需自行配置。 */
export const CONTEXT_TOKEN_BUDGET = 256_000;
/** 估算超过预算的 80% 触发压缩/截断（#7）；#57 起高水位主要触发 compaction。 */
export const COMPACT_HIGH_WATER = 0.8;
/** 压缩/截断目标水位：降到预算的 60% 以下。 */
export const COMPACT_LOW_WATER = 0.6;
/** 压缩后保留尾部占预算的比例（#57）：摘要 + 尾部 = 压缩目标状态。 */
export const COMPACT_TAIL_FRACTION = 0.2;
/** 摘要消息的前缀标记（运行时与 wire 冷重建共用）。 */
export const SUMMARY_MARKER = "[上下文摘要（压缩后）]";
/**
 * 摘要调用的系统 prompt（#57，对齐 Codex 的 handoff 模板：
 * 进度/关键决策/约束与偏好/剩余步骤/关键数据引用）。
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `你正在执行上下文压缩：把下面这段对话历史压缩成一份交接摘要，供接手继续任务的模型使用。必须覆盖：已完成的进度与关键决策；重要的约束与用户偏好；接下来要做的剩余步骤；继续任务所需的关键数据、示例与引用（文件路径、工具调用、已读/已改文件）。若历史中有未完成的工具调用意图，保留之。用中文分点输出，控制在 300 字以内，不要编造历史中不存在的信息。`;

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

/**
 * 保留尾部（#57）：从最新往回按组挑选直到 tailTokens 预算，整组不拆
 * （带 toolCalls 的 assistant 与其 tool 回复同进退）；最新一组即使超限也保留。
 * 运行时压缩与 wire 冷重建共用此纯函数，保证压缩点重建 == 压缩后状态。
 */
export function pickRetainedTail(messages: Message[], tailTokens: number): Message[] {
  const groups = groupMessages(messages);
  const kept: Message[][] = [];
  let tokens = 0;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i]!;
    const groupTokens = estimateTokens(group);
    if (kept.length > 0 && tokens + groupTokens > tailTokens) break;
    kept.unshift(group);
    tokens += groupTokens;
  }
  if (kept.length === 0 && groups.length > 0) {
    kept.unshift(groups[groups.length - 1]!);
  }
  return kept.flat();
}

/**
 * 压缩切分（#57）：system 独立；head 交给摘要，tail 原样保留。
 * head 为空表示无可压缩（摘要调用不会发生）。
 */
export function splitForCompaction(
  messages: Message[],
  tailTokens: number,
): { system: Message[]; head: Message[]; tail: Message[] } {
  const hasSystem = messages[0]?.role === "system";
  const system = hasSystem ? [messages[0]!] : [];
  const rest = messages.slice(hasSystem ? 1 : 0);
  const tail = pickRetainedTail(rest, tailTokens);
  const head = rest.slice(0, rest.length - tail.length);
  return { system, head, tail };
}

/** 压缩产生的摘要消息：以 user 消息占位（协议安全，可出现在任意位置）。 */
export function summaryMessage(summary: string): Message {
  return { role: "user", content: `${SUMMARY_MARKER}\n${summary}` };
}
