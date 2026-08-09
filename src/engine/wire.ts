import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pickRetainedTail, summaryMessage } from "./context.ts";
import type { EngineEvent } from "./events.ts";
import type { Message, ToolCall } from "./llm/types.ts";
import type { TodoItem } from "./todo.ts";

export interface WireRow {
  seq: number;
  event: EngineEvent;
}

/** append-only 事件日志：每行一个 JSON，seq 单调递增。只做追加，不做检查点。 */
const defaultWarn = (message: string): void => {
  process.stderr.write(message + "\n");
};

/** 解析一行 wire 记录；空行/坏行返回 undefined（#42 容错，如何呈现由调用方决定）。 */
export function parseWireRow(line: string): WireRow | undefined {
  if (line.trim() === "") return undefined;
  try {
    return JSON.parse(line) as WireRow;
  } catch {
    return undefined;
  }
}

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

  /**
   * 读出全部行。坏 JSON 行跳过并告警（带行号，#42）——
   * 冷重建不能被单行损坏整体拖死。
   */
  async readAll(onWarn: (message: string) => void = defaultWarn): Promise<WireRow[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: WireRow[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const row = parseWireRow(line);
      if (row === undefined) {
        onWarn(`wire: 跳过损坏行 ${i + 1}（${line.slice(0, 50)}${line.length > 50 ? "…" : ""}）`);
        continue;
      }
      rows.push(row);
    }
    return rows;
  }

  /** 删除 wire 日志（/delete 用）；下次 append 重新从 seq 1 开始。 */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    this.nextSeq = undefined;
  }
}

/** Loop 看到的 wire 窄面：追加一个事件 + 等待落盘。排序与失败语义由实现保证。 */
export interface EventSink {
  append(event: EngineEvent): void;
  /** 等待已接受的追加全部落盘（turn 收尾时调用）；不抛错。 */
  flush(): Promise<void>;
}

/**
 * WireService 的串行 sink：append-only 日志要求保序，异步链在这里维护；
 * 单次落盘失败告警后继续接受后续事件——一个坏事件不能拖死整条日志。
 */
export class WireEventSink implements EventSink {
  private queue: Promise<unknown> = Promise.resolve();

  private readonly wire: Pick<WireService, "append">;

  private readonly onError: (error: unknown) => void;

  constructor(
    wire: Pick<WireService, "append">,
    onError: (error: unknown) => void = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`wire: 事件落盘失败（已跳过，后续事件不受影响）：${message}\n`);
    },
  ) {
    this.wire = wire;
    this.onError = onError;
  }

  append(event: EngineEvent): void {
    this.queue = this.queue
      .then(() => this.wire.append(event))
      .catch((error: unknown) => {
        this.onError(error);
      });
  }

  async flush(): Promise<void> {
    await this.queue;
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
        case "context.usage":
        case "context.compacted":
        case "todo.updated":
          // 思考流、审批留痕、用量指标、压缩事件、todo 状态事实不参与消息重建（transcript 是全量日志）
          break;
      }
    }
    flushAssistant();
    return messages;
  }

  /**
   * todo 状态还原（#58）：todo.updated 是「最新全量列表」的覆盖式快照，
   * 折叠取最后一个事件即为当前 todo 态（与 #57 的 context.compacted 同构：状态事实进 wire，重建还原）。
   */
  rebuildTodos(rows: WireRow[]): TodoItem[] {
    let items: TodoItem[] = [];
    for (const { event } of rows) {
      if (event.type === "todo.updated") items = event.items;
    }
    return items;
  }

  /**
   * 上下文通道（#29，#6 决策，#57 压缩复位）：折叠出协议形状的 Message[] 喂回 LLM。
   * tool.call 自带 id，与 tool.result 配对还原 toolCalls/toolCallId；
   * 每个 tool_call 必有 tool 回复（loop 的不变量）， pairing 不会断。
   * context.compacted 是上下文复位点：用与运行时同一纯函数按 tailTokens 重算
   * 保留尾部，复位为 [摘要, ...尾部]，之后的折叠继续——重建上下文 == 压缩后状态。
   */
  rebuildForContext(rows: WireRow[]): Message[] {
    let messages: Message[] = [];
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
        case "context.compacted": {
          // 压缩点 = 上下文复位点：同一纯函数重算保留尾部，复位后继续折叠（#57）
          const retainedTail = pickRetainedTail(messages, event.tailTokens);
          messages = [summaryMessage(event.summary), ...retainedTail];
          assistantText = "";
          pendingCalls = [];
          break;
        }
        case "assistant.think":
        case "approval.request":
        case "approval.decision":
        case "context.usage":
        case "todo.updated":
          break;
      }
    }
    flushAssistant();
    return messages;
  }
}
