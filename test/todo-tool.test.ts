import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap.ts";
import { EventBus, type EngineEvent } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import { Loop } from "../src/engine/loop.ts";
import { TodoStore, type TodoItem } from "../src/engine/todo.ts";
import { registerBuiltinTools } from "../src/engine/tools/builtins.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { WireEventSink, WireService } from "../src/engine/wire.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const PLAN: TodoItem[] = [
  { content: "读代码", status: "pending" },
  { content: "写测试", status: "in_progress" },
  { content: "提交", status: "done" },
];

describe("todo tool", () => {
  let dir: string;
  let executor: ToolExecutor;
  let todos: TodoStore;

  beforeEach(() => {
    dir = makeTempDir("todo-test-");
    executor = new ToolExecutor();
    todos = new TodoStore();
    registerBuiltinTools(executor, dir, todos);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered as a read-class tool (in-memory state, no approval prompt)", () => {
    expect(executor.approvalKind("todo")).toBe("read");
  });

  it("accepts a full list and echoes the confirmed list back", async () => {
    const result = await executor.execute("todo", { todos: PLAN });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("todos (3)");
    expect(result.output).toContain("[pending] 读代码");
    expect(result.output).toContain("[in_progress] 写测试");
    expect(result.output).toContain("[done] 提交");
    expect(todos.list()).toEqual(PLAN);
  });

  it("overwrites the whole list on the next call", async () => {
    await executor.execute("todo", { todos: PLAN });
    const result = await executor.execute("todo", { todos: [{ content: "c", status: "done" }] });
    expect(result.ok).toBe(true);
    expect(todos.list()).toEqual([{ content: "c", status: "done" }]);
  });

  it("rejects an unknown status with an actionable error and keeps the state unchanged", async () => {
    const result = await executor.execute("todo", {
      todos: [{ content: "x", status: "finished" }],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("pending | in_progress | done");
    expect(todos.list()).toEqual([]);
  });

  it("rejects an empty content", async () => {
    const result = await executor.execute("todo", {
      todos: [{ content: "", status: "pending" }],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("content");
  });

  it("rejects more than one in_progress item and names the conflicts", async () => {
    const result = await executor.execute("todo", {
      todos: [
        { content: "写测试", status: "in_progress" },
        { content: "重构", status: "in_progress" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("写测试");
    expect(result.output).toContain("重构");
    expect(todos.list()).toEqual([]);
  });

  it("clears the list with an empty todos array", async () => {
    await executor.execute("todo", { todos: PLAN });
    const result = await executor.execute("todo", { todos: [] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("cleared");
    expect(todos.list()).toEqual([]);
  });

  it("rejects a non-array todos argument", async () => {
    const result = await executor.execute("todo", { todos: "nope" });
    expect(result.ok).toBe(false);
  });

  it("fires onChange with the accepted list on success, not on failure", async () => {
    const seen: TodoItem[][] = [];
    todos.onChange = (items) => seen.push(items);
    await executor.execute("todo", { todos: [{ content: "a", status: "pending" }] });
    await executor.execute("todo", { todos: [{ content: "x", status: "bogus" }] });
    expect(seen).toEqual([[{ content: "a", status: "pending" }]]);
  });
});

describe("todo events into wire and loop", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("todo-loop-test-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes todo.updated between tool.call and tool.result and feeds the echo back", async () => {
    const wirePath = join(dir, "wire.jsonl");
    const bus = new EventBus();
    const events: EngineEvent[] = [];
    bus.on("tool.call", (p) => events.push({ type: "tool.call", ...p }));
    bus.on("todo.updated", (p) => events.push({ type: "todo.updated", ...p }));
    bus.on("tool.result", (p) => events.push({ type: "tool.result", ...p }));
    bus.on("assistant.delta", (p) => events.push({ type: "assistant.delta", ...p }));

    const executor = new ToolExecutor();
    const todos = new TodoStore();
    registerBuiltinTools(executor, dir, todos);
    const sink = new WireEventSink(new WireService(wirePath));
    // bootstrap 同款装配:store 变更 → 双通道(bus 给 UI,sink 进 wire)
    todos.onChange = (items) => {
      bus.emit("todo.updated", { items });
      sink.append({ type: "todo.updated", items });
    };

    const llm = new FakeLLM([
      [
        {
          type: "tool_call",
          id: "t1",
          name: "todo",
          args: { todos: [{ content: "写测试", status: "in_progress" }] },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "text", text: "已建 todo" }, { type: "finish", reason: "stop" }],
    ]);
    const loop = new Loop({ llm, executor, bus, systemPrompt: "sys", sink });
    await loop.runTurn("建个计划");

    expect(events.map((e) => e.type)).toEqual([
      "tool.call",
      "todo.updated",
      "tool.result",
      "assistant.delta",
    ]);
    expect(events[1]).toEqual({
      type: "todo.updated",
      items: [{ content: "写测试", status: "in_progress" }],
    });

    // 回灌:模型下一轮能看到确认列表
    const toolMessage = llm.requests[1]!.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ role: "tool", toolCallId: "t1", name: "todo" });
    expect(String(toolMessage && "content" in toolMessage ? toolMessage.content : "")).toContain(
      "[in_progress] 写测试",
    );

    // wire 落盘与 bus 同序:todo.updated 夹在 tool.call 与 tool.result 之间
    const rows = await new WireService(wirePath).readAll();
    const kinds = rows.map((r) => r.event.type);
    expect(kinds[kinds.indexOf("tool.call") + 1]).toBe("todo.updated");
    expect(kinds[kinds.indexOf("todo.updated") + 1]).toBe("tool.result");
  });

  it("bootstrap resume restores todo state from the wire", async () => {
    const wirePath = join(dir, "wire.jsonl");
    const wire = new WireService(wirePath);
    await wire.append({ type: "turn.started", turnId: 1, prompt: "建计划" });
    await wire.append({
      type: "todo.updated",
      items: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
      ],
    });
    await wire.append({ type: "turn.ended", turnId: 1, reason: "finish" });

    const agent = await bootstrap({
      workspace: dir,
      fake: true,
      session: { resume: wirePath },
      sessionRoot: dir,
    });

    expect(agent.todos.list()).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
    ]);
  });
});
