import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineEvent } from "./events.ts";
import type { Message, ToolCall } from "./llm/types.ts";

export interface WireRow {
  seq: number;
  event: EngineEvent;
}

/** append-only 事件日志：每行一个 JSON，seq 单调递增。只做追加，不做检查点。 */
export class WireService {
  private nextSeq: number | undefined;

  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(event: EngineEvent): Promise<WireRow> {
    if (this.nextSeq === undefined) {
      const existing = await this.readAll();
      this.nextSeq = existing.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
    }
    const row: WireRow = { seq: this.nextSeq, event };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(row) + "\n", "utf8");
    this.nextSeq += 1;
    return row;
  }

  async readAll(): Promise<WireRow[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as WireRow);
  }

  /** 删除 wire 日志（/delete 用）；下次 append 重新从 seq 1 开始。 */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    this.nextSeq = undefined;
  }
}

export type RebuiltMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; name: string; args: Record<string, unknown>; ok: boolean; output: string };

/** 读 wire 日志按 seq 折叠出消息列表（冷重建；不追求无损，只恢复大致顺序）。 */
export class Rebuilder {
  rebuild(rows: WireRow[]): RebuiltMessage[] {
    const messages: RebuiltMessage[] = [];
    let assistantText = "";
    const pendingCalls = new Map<string, { name: string; args: Record<string, unknown> }>();

    const flushAssistant = () => {
      if (assistantText !== "") {
        messages.push({ role: "assistant", text: assistantText });
        assistantText = "";
      }
    };

    for (const { event } of rows) {
      switch (event.type) {
        case "turn.started":
          flushAssistant();
          messages.push({ role: "user", text: event.prompt });
          break;
        case "assistant.delta":
          assistantText += event.text;
          break;
        case "tool.call":
          flushAssistant();
          pendingCalls.set(event.id, { name: event.name, args: event.args });
          break;
        case "tool.result": {
          const call = pendingCalls.get(event.id);
          messages.push({
            role: "tool",
            name: event.name,
            args: call?.args ?? {},
            ok: event.ok,
            output: event.output,
          });
          pendingCalls.delete(event.id);
          break;
        }
        case "turn.ended":
          flushAssistant();
          break;
        case "assistant.think":
        case "approval.request":
        case "approval.decision":
          // 思考流与审批留痕不参与消息重建
          break;
      }
    }
    flushAssistant();
    return messages;
  }

  /**
   * 上下文通道（#29，#6 决策）：折叠出协议形状的 Message[] 喂回 LLM。
   * tool.call 自带 id，与 tool.result 配对还原 toolCalls/toolCallId；
   * 每个 tool_call 必有 tool 回复（loop 的不变量）， pairing 不会断。
   */
  rebuildForContext(rows: WireRow[]): Message[] {
    const messages: Message[] = [];
    let assistantText = "";
    let pendingCalls: ToolCall[] = [];
    // 中断的会话可能留下没有 tool.result 的 tool.call；协议要求配对，缺的结果合成占位
    const answeredIds = new Set(
      rows.filter((r) => r.event.type === "tool.result").map((r) => (r.event as { id: string }).id),
    );

    const flushAssistant = () => {
      if (assistantText !== "" || pendingCalls.length > 0) {
        const message: Message = {
          role: "assistant",
          content: assistantText,
          ...(pendingCalls.length > 0 ? { toolCalls: pendingCalls } : {}),
        };
        messages.push(message);
        for (const call of pendingCalls) {
          if (!answeredIds.has(call.id)) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: "(session interrupted before tool result)",
            });
          }
        }
        assistantText = "";
        pendingCalls = [];
      }
    };

    for (const { event } of rows) {
      switch (event.type) {
        case "turn.started":
          flushAssistant();
          messages.push({ role: "user", content: event.prompt });
          break;
        case "assistant.delta":
          assistantText += event.text;
          break;
        case "tool.call":
          pendingCalls.push({ id: event.id, name: event.name, args: event.args });
          break;
        case "tool.result":
          // tool 消息跟在带 toolCalls 的 assistant 消息之后（协议顺序）
          flushAssistant();
          messages.push({
            role: "tool",
            toolCallId: event.id,
            name: event.name,
            content: event.output,
          });
          break;
        case "turn.ended":
          flushAssistant();
          break;
        case "assistant.think":
        case "approval.request":
        case "approval.decision":
          break;
      }
    }
    flushAssistant();
    return messages;
  }
}
