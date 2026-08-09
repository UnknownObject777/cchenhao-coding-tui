import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/engine/events.ts";
import { SUMMARY_MARKER } from "../src/engine/context.ts";
import { Rebuilder, WireEventSink, WireService } from "../src/engine/wire.ts";

const turn1: EngineEvent[] = [
  { type: "turn.started", turnId: 1, prompt: "hello" },
  { type: "assistant.delta", text: "Hi " },
  { type: "assistant.delta", text: "there" },
  { type: "tool.call", id: "c1", name: "read_file", args: { path: "a.txt" } },
  { type: "tool.result", id: "c1", name: "read_file", ok: true, output: "contents" },
  { type: "assistant.delta", text: "!" },
  { type: "turn.ended", turnId: 1, reason: "finish" },
];

describe("wire", () => {
  let dir: string;
  let wirePath: string;

  beforeEach(() => {
    dir = makeTempDir("wire-test-");
    wirePath = join(dir, "wire.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends events and reads them back with contiguous seq", async () => {
    const wire = new WireService(wirePath);
    for (const event of turn1) await wire.append(event);

    const rows = await wire.readAll();

    expect(rows.map((r) => r.event)).toEqual(turn1);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("continues seq when appending to an existing log", async () => {
    const first = new WireService(wirePath);
    await first.append(turn1[0]!);

    const second = new WireService(wirePath);
    await second.append(turn1[5]!);

    const rows = await new WireService(wirePath).readAll();
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]!.event).toEqual(turn1[5]);
  });

  it("derives the next seq from the max existing seq, not the line count", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      wirePath,
      '{"seq":5,"event":{"type":"turn.ended","turnId":1,"reason":"finish"}}\n' +
        '{"seq":7,"event":{"type":"turn.ended","turnId":2,"reason":"finish"}}\n',
    );

    const wire = new WireService(wirePath);
    const row = await wire.append(turn1[0]!);

    expect(row.seq).toBe(8);
  });

  it("reads an empty log as no events", async () => {
    expect(await new WireService(wirePath).readAll()).toEqual([]);
  });

  it("rebuilds the message list from the event sequence", async () => {
    const wire = new WireService(wirePath);
    for (const event of turn1) await wire.append(event);

    const messages = new Rebuilder().rebuild(await wire.readAll());

    expect(messages).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hi there" },
      { role: "tool", name: "read_file", args: { path: "a.txt" }, ok: true, output: "contents" },
      { role: "assistant", text: "!" },
    ]);
  });

  it("clear removes the log file and restarts seq from 1", async () => {
    const wire = new WireService(wirePath);
    for (const event of turn1) await wire.append(event);

    await wire.clear();

    expect(await wire.readAll()).toEqual([]);
    await wire.append(turn1[0]!);
    const rows = await wire.readAll();
    expect(rows.map((r) => r.seq)).toEqual([1]);
  });

  it("clear on a missing file is a no-op", async () => {
    await expect(new WireService(wirePath).clear()).resolves.toBeUndefined();
  });

  it("readAll skips corrupted lines with a line-numbered warning (#42)", async () => {
    const wire = new WireService(wirePath);
    await wire.append({ type: "turn.started", turnId: 1, prompt: "good" });
    // 手工塞一行坏 JSON
    const { appendFile } = await import("node:fs/promises");
    await appendFile(wirePath, "{broken json\n", "utf8");
    await wire.append({ type: "turn.ended", turnId: 1, reason: "finish" });

    const warnings: string[] = [];
    const rows = await new WireService(wirePath).readAll((m) => warnings.push(m));

    expect(rows.map((r) => r.event.type)).toEqual(["turn.started", "turn.ended"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("行 2");
  });

  it("rebuilder skips approval events without breaking the fold", async () => {
    const events: EngineEvent[] = [
      { type: "turn.started", turnId: 1, prompt: "hi" },
      { type: "tool.call", id: "c1", name: "write_file", args: { path: "a.txt" } },
      { type: "approval.request", id: "c1", name: "write_file", args: { path: "a.txt" }, level: "confirm" },
      { type: "approval.decision", id: "c1", decision: "deny" },
      { type: "tool.result", id: "c1", name: "write_file", ok: false, output: "denied" },
      { type: "turn.ended", turnId: 1, reason: "finish" },
    ];
    const wire = new WireService(wirePath);
    for (const event of events) await wire.append(event);

    const messages = new Rebuilder().rebuild(await wire.readAll());

    expect(messages).toEqual([
      { role: "user", text: "hi" },
      { role: "tool", name: "write_file", args: { path: "a.txt" }, ok: false, output: "denied" },
    ]);
  });

  it("rebuildForContext treats a compaction event as a context reset point", async () => {
    const events: EngineEvent[] = [
      { type: "turn.started", turnId: 1, prompt: "old ask" },
      { type: "assistant.delta", text: "x".repeat(400) },
      { type: "turn.ended", turnId: 1, reason: "finish" },
      { type: "turn.started", turnId: 2, prompt: "recent ask" },
      { type: "assistant.delta", text: "recent answer" },
      { type: "turn.ended", turnId: 2, reason: "finish" },
      { type: "context.compacted", summary: "handoff", tailTokens: 10 },
      { type: "turn.started", turnId: 3, prompt: "new ask" },
      { type: "assistant.delta", text: "new answer" },
      { type: "turn.ended", turnId: 3, reason: "finish" },
    ];
    const wire = new WireService(wirePath);
    for (const event of events) await wire.append(event);

    const messages = new Rebuilder().rebuildForContext(await wire.readAll());

    // 压缩点 = 上下文复位点:旧对话被摘要替换,仅保留按 tailTokens 挑出的最近尾部,
    // 之后的事件照常折叠 —— 重建上下文 == 压缩后状态(#57)
    expect(messages).toEqual([
      { role: "user", content: `${SUMMARY_MARKER}\nhandoff` },
      { role: "user", content: "recent ask" },
      { role: "assistant", content: "recent answer" },
      { role: "user", content: "new ask" },
      { role: "assistant", content: "new answer" },
    ]);
  });

  it("rebuild (UI channel) ignores the compaction event and keeps the full transcript", async () => {
    const events: EngineEvent[] = [
      { type: "turn.started", turnId: 1, prompt: "old ask" },
      { type: "assistant.delta", text: "old answer" },
      { type: "turn.ended", turnId: 1, reason: "finish" },
      { type: "context.compacted", summary: "handoff", tailTokens: 10 },
      { type: "turn.started", turnId: 2, prompt: "new ask" },
      { type: "assistant.delta", text: "new answer" },
      { type: "turn.ended", turnId: 2, reason: "finish" },
    ];
    const wire = new WireService(wirePath);
    for (const event of events) await wire.append(event);

    const messages = new Rebuilder().rebuild(await wire.readAll());

    expect(messages).toEqual([
      { role: "user", text: "old ask" },
      { role: "assistant", text: "old answer" },
      { role: "user", text: "new ask" },
      { role: "assistant", text: "new answer" },
    ]);
  });

  it("rebuildTodos returns the last todo.updated list (full-snapshot overwrite)", async () => {
    const events: EngineEvent[] = [
      { type: "todo.updated", items: [{ content: "a", status: "pending" }] },
      { type: "todo.updated", items: [{ content: "a", status: "in_progress" }] },
      { type: "todo.updated", items: [] },
      { type: "todo.updated", items: [{ content: "a", status: "done" }] },
    ];
    const wire = new WireService(wirePath);
    for (const event of events) await wire.append(event);

    expect(new Rebuilder().rebuildTodos(await wire.readAll())).toEqual([
      { content: "a", status: "done" },
    ]);
  });

  it("rebuildTodos returns [] when no todo event exists", async () => {
    const wire = new WireService(wirePath);
    for (const event of turn1) await wire.append(event);

    expect(new Rebuilder().rebuildTodos(await wire.readAll())).toEqual([]);
  });

  it("rebuild and rebuildForContext skip todo.updated without breaking tool pairing", async () => {
    const events: EngineEvent[] = [
      { type: "turn.started", turnId: 1, prompt: "hi" },
      {
        type: "tool.call",
        id: "c1",
        name: "todo",
        args: { todos: [{ content: "a", status: "pending" }] },
      },
      { type: "todo.updated", items: [{ content: "a", status: "pending" }] },
      { type: "tool.result", id: "c1", name: "todo", ok: true, output: "todos (1):\n1. [pending] a" },
      { type: "turn.ended", turnId: 1, reason: "finish" },
    ];
    const wire = new WireService(wirePath);
    for (const event of events) await wire.append(event);

    // UI 通道:todo 状态事实不掺进消息流,工具配对不受夹心事件影响
    expect(new Rebuilder().rebuild(await wire.readAll())).toEqual([
      { role: "user", text: "hi" },
      {
        role: "tool",
        name: "todo",
        args: { todos: [{ content: "a", status: "pending" }] },
        ok: true,
        output: "todos (1):\n1. [pending] a",
      },
    ]);
    // 上下文通道:协议形状不变
    expect(new Rebuilder().rebuildForContext(await wire.readAll())).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "todo", args: { todos: [{ content: "a", status: "pending" }] } }],
      },
      { role: "tool", toolCallId: "c1", name: "todo", content: "todos (1):\n1. [pending] a" },
    ]);
  });
});

describe("WireEventSink", () => {
  it("preserves append order across interleaved calls", async () => {
    const dir = makeTempDir("wire-sink-test-");
    try {
      const wirePath = join(dir, "wire.jsonl");
      const sink = new WireEventSink(new WireService(wirePath));
      for (const event of turn1) sink.append(event);
      await sink.flush();

      const rows = await new WireService(wirePath).readAll();
      expect(rows.map((r) => r.event)).toEqual(turn1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed append is reported and does not kill later appends; flush never throws", async () => {
    const dir = makeTempDir("wire-sink-test-");
    try {
      const wirePath = join(dir, "wire.jsonl");
      const errors: unknown[] = [];
      let calls = 0;
      // 第一次 append 失败，之后恢复（如瞬时 ENOSPC/锁冲突）
      const flaky = {
        append: async (event: EngineEvent) => {
          calls += 1;
          if (calls === 1) throw new Error("disk full");
          return new WireService(wirePath).append(event);
        },
      };
      const sink = new WireEventSink(flaky, (e) => errors.push(e));

      sink.append(turn1[0]!);
      sink.append(turn1[1]!);
      await expect(sink.flush()).resolves.toBeUndefined();

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("disk full");
      const rows = await new WireService(wirePath).readAll();
      expect(rows.map((r) => r.event)).toEqual([turn1[1]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
