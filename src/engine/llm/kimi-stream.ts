import type { ModelEvent } from "./types.ts";

/** OpenAI 兼容 chat completion 流 chunk 的最小类型（只声明我们用到的字段）。 */
export interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

/** 从一段 SSE 原文中提取 data 载荷（忽略注释行与 [DONE]）。 */
export function parseSseData(raw: string): string[] {
  const payloads: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data !== "" && data !== "[DONE]") payloads.push(data);
  }
  return payloads;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 把 chat completion chunk 流转成 ModelEvent 流。
 * tool_call 的参数片段按 index 缓冲，finish_reason=tool_calls 时一次性发出。
 */
export class ChunkConverter {
  private readonly pending = new Map<number, PendingToolCall>();
  private finished = false;

  push(chunk: ChatChunk): ModelEvent[] {
    const events: ModelEvent[] = [];
    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta;
    if (delta?.reasoning_content) events.push({ type: "think", text: delta.reasoning_content });
    if (delta?.content) events.push({ type: "text", text: delta.content });

    for (const call of delta?.tool_calls ?? []) {
      const slot = this.pending.get(call.index) ?? { id: "", name: "", arguments: "" };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
      this.pending.set(call.index, slot);
    }

    if (choice.finish_reason) {
      this.finished = true;
      events.push(...this.flushPending());
      events.push({ type: "finish", reason: choice.finish_reason });
    }
    return events;
  }

  /** 流结束兜底：冲刷未完成的 tool call；若全程没有 finish_reason 则补一个 finish。 */
  end(): ModelEvent[] {
    const events = this.flushPending();
    if (!this.finished) {
      this.finished = true;
      events.push({ type: "finish", reason: events.length > 0 ? "tool_calls" : "stop" });
    }
    return events;
  }

  private flushPending(): ModelEvent[] {
    const events: ModelEvent[] = [...this.pending.values()].map((slot) => ({
      type: "tool_call",
      id: slot.id,
      name: slot.name,
      args: parseArgs(slot.arguments),
    }));
    this.pending.clear();
    return events;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __raw: raw };
  }
}
