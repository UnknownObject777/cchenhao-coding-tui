import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineEvent } from "./events.js";

export interface WireRow {
  seq: number;
  event: EngineEvent;
}

/** append-only 事件日志：每行一个 JSON，seq 单调递增。只做追加，不做检查点。 */
export class WireService {
  private nextSeq: number | undefined;

  constructor(private readonly path: string) {}

  async append(event: EngineEvent): Promise<WireRow> {
    if (this.nextSeq === undefined) {
      const existing = await this.readAll();
      this.nextSeq = existing.length + 1;
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
          break;
      }
    }
    flushAssistant();
    return messages;
  }
}
