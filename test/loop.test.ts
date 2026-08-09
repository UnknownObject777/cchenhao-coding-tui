import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type EngineEvent } from "../src/engine/events.ts";
import type { ApprovalGate } from "../src/engine/approval/gate.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import type { LLMRequester, Message, ModelEvent, ToolSpec } from "../src/engine/llm/types.ts";
import { Loop } from "../src/engine/loop.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { WireEventSink, WireService } from "../src/engine/wire.ts";

function setup(
  script: ConstructorParameters<typeof FakeLLM>[0],
  wirePath?: string,
  approvalGate?: ApprovalGate,
) {
  const bus = new EventBus();
  const events: EngineEvent[] = [];
  bus.on("turn.started", (p) => events.push({ type: "turn.started", ...p }));
  bus.on("assistant.delta", (p) => events.push({ type: "assistant.delta", ...p }));
  bus.on("tool.call", (p) => events.push({ type: "tool.call", ...p }));
  bus.on("tool.result", (p) => events.push({ type: "tool.result", ...p }));
  bus.on("approval.decision", (p) => events.push({ type: "approval.decision", ...p }));
  bus.on("context.usage", (p) => events.push({ type: "context.usage", ...p }));
  bus.on("turn.ended", (p) => events.push({ type: "turn.ended", ...p }));

  const executor = new ToolExecutor();
  executor.register({
    name: "read_file",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: (args) => `contents of ${String(args["path"])}`,
  });

  const llm = new FakeLLM(script);
  const loop = new Loop({
    llm,
    executor,
    bus,
    systemPrompt: "you are a toy",
    ...(wirePath ? { sink: new WireEventSink(new WireService(wirePath)) } : {}),
    ...(approvalGate ? { approvalGate } : {}),
  });
  return { loop, events, llm };
}

describe("loop", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("loop-test-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes events in order across a tool-call turn", async () => {
    const { loop, events } = setup([
      [
        { type: "text", text: "Let me look. " },
        { type: "tool_call", id: "c1", name: "read_file", args: { path: "a.txt" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", text: "It says hi." },
        { type: "finish", reason: "stop" },
      ],
    ]);

    await loop.runTurn("what is in a.txt?");

    const kinds = events.filter((e) => e.type !== "context.usage");
    expect(kinds.map((e) => e.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "tool.call",
      "tool.result",
      "assistant.delta",
      "turn.ended",
    ]);
    expect(kinds[1]).toEqual({ type: "assistant.delta", text: "Let me look. " });
    expect(kinds[2]).toEqual({
      type: "tool.call",
      id: "c1",
      name: "read_file",
      args: { path: "a.txt" },
    });
    expect(kinds[3]).toEqual({
      type: "tool.result",
      id: "c1",
      name: "read_file",
      ok: true,
      output: "contents of a.txt",
    });
    expect(kinds[5]).toEqual({ type: "turn.ended", turnId: 1, reason: "finish" });
  });

  it("feeds the tool result back into the next llm request", async () => {
    const { loop, llm } = setup([
      [
        { type: "tool_call", id: "c1", name: "read_file", args: { path: "a.txt" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "finish", reason: "stop" }],
    ]);

    await loop.runTurn("read a.txt");

    const secondRequest = llm.requests[1]!;
    const toolMessage = secondRequest.find((m) => m.role === "tool");
    expect(toolMessage).toEqual({
      role: "tool",
      toolCallId: "c1",
      name: "read_file",
      content: "contents of a.txt",
    });
    const assistantMessage = secondRequest.find((m) => m.role === "assistant");
    expect(assistantMessage).toMatchObject({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
    });
  });

  it("ends the turn with an error event when the tool result keeps failing", async () => {
    const executor = new ToolExecutor(); // no tools registered
    const bus = new EventBus();
    const events: EngineEvent[] = [];
    bus.on("tool.result", (p) => events.push({ type: "tool.result", ...p }));
    bus.on("turn.ended", (p) => events.push({ type: "turn.ended", ...p }));
    const llm = new FakeLLM([
      [
        { type: "tool_call", id: "c1", name: "ghost", args: {} },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "text", text: "sorry" }, { type: "finish", reason: "stop" }],
    ]);
    const loop = new Loop({ llm, executor, bus, systemPrompt: "" });

    await loop.runTurn("boo");

    expect(events[0]).toMatchObject({ type: "tool.result", ok: false });
    expect(events[1]).toMatchObject({ type: "turn.ended", reason: "finish" });
  });

  it("still executes tool calls when the stream ends with finish_reason stop", async () => {
    const { loop, events, llm } = setup([
      // 模型吐了 tool_call 但 finish_reason 是 "stop"（真实 API 偶发）——工具仍须执行并回灌。
      [
        { type: "tool_call", id: "c1", name: "read_file", args: { path: "a.txt" } },
        { type: "finish", reason: "stop" },
      ],
      [{ type: "text", text: "got it" }, { type: "finish", reason: "stop" }],
    ]);

    await loop.runTurn("read a.txt");

    const kinds = events.filter((e) => e.type !== "context.usage");
    expect(kinds.map((e) => e.type)).toEqual([
      "turn.started",
      "tool.call",
      "tool.result",
      "assistant.delta",
      "turn.ended",
    ]);
    expect(llm.requests[1]!.some((m) => m.role === "tool")).toBe(true);
  });

  it("appends every emitted event to the wire log", async () => {
    const wirePath = join(dir, "wire.jsonl");
    const { loop, events } = setup(
      [
        [{ type: "text", text: "hi" }, { type: "finish", reason: "stop" }],
      ],
      wirePath,
    );

    await loop.runTurn("say hi");

    const rows = await new WireService(wirePath).readAll();
    expect(rows.map((r) => r.event)).toEqual(events);
  });

  it("reset clears conversation history but keeps the system prompt", async () => {
    const { loop, llm } = setup([
      [{ type: "text", text: "first" }, { type: "finish", reason: "stop" }],
      [{ type: "text", text: "second" }, { type: "finish", reason: "stop" }],
    ]);

    await loop.runTurn("turn one");
    loop.reset();
    await loop.runTurn("turn two");

    const secondRequest = llm.requests[1];
    expect(secondRequest).toEqual([
      { role: "system", content: "you are a toy" },
      { role: "user", content: "turn two" },
    ]);
  });

  it("denied tool calls are not executed but fed back as a failed tool result", async () => {
    const { loop, events, llm } = setup(
      [
        [
          { type: "tool_call", id: "c1", name: "read_file", args: { path: "secret.txt" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text", text: "好吧" }, { type: "finish", reason: "stop" }],
      ],
      undefined,
      { request: () => Promise.resolve("deny") },
    );

    await loop.runTurn("read secret.txt");

    const kinds = events.filter((e) => e.type !== "context.usage");
    expect(kinds.map((e) => e.type)).toEqual([
      "turn.started",
      "tool.call",
      "approval.decision",
      "tool.result",
      "assistant.delta",
      "turn.ended",
    ]);
    expect(kinds[2]).toEqual({ type: "approval.decision", id: "c1", decision: "deny" });
    expect(kinds[3]).toMatchObject({ type: "tool.result", id: "c1", ok: false });
    // 拒绝结果回灌进下一轮请求（协议要求每个 tool_call 都有 tool 回复）
    const toolMessage = llm.requests[1]!.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(String(toolMessage && "content" in toolMessage ? toolMessage.content : "")).toContain("denied");
  });

  it("allowed tool calls execute normally through the gate", async () => {
    const { loop, events } = setup(
      [
        [
          { type: "tool_call", id: "c1", name: "read_file", args: { path: "a.txt" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      undefined,
      { request: () => Promise.resolve("allow") },
    );

    await loop.runTurn("read a.txt");

    expect(events).toContainEqual({ type: "approval.decision", id: "c1", decision: "allow" });
    expect(events).toContainEqual({
      type: "tool.result",
      id: "c1",
      name: "read_file",
      ok: true,
      output: "contents of a.txt",
    });
  });

  it("compact() is a no-op when there is nothing to compact", async () => {
    const llm = new FakeLLM([[{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }]]);
    const loop = new Loop({ llm, executor: new ToolExecutor(), bus: new EventBus(), systemPrompt: "sys" });

    expect(await loop.compact()).toBe(false);
    loop.loadHistory([{ role: "user", content: "hi" }]); // 只有一条消息,尾部就是它
    expect(await loop.compact()).toBe(false);
    expect(llm.requests).toHaveLength(0); // 没有可压缩内容就不烧 LLM 调用
  });

  it("compact() summarizes old messages, records the event and the next request starts compacted", async () => {
    const dir = makeTempDir("compact-test-");
    try {
      const wirePath = join(dir, "wire.jsonl");
      const bus = new EventBus();
      const events: EngineEvent[] = [];
      bus.on("context.compacted", (p) => events.push({ type: "context.compacted", ...p }));
      const llm = new FakeLLM([
        [{ type: "text", text: "handoff" }, { type: "finish", reason: "stop" }],
        [{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }],
      ]);
      const loop = new Loop({
        llm,
        executor: new ToolExecutor(),
        bus,
        systemPrompt: "sys",
        contextTokenBudget: 100,
        sink: new WireEventSink(new WireService(wirePath)),
      });
      loop.loadHistory([
        { role: "user", content: "a".repeat(100) },
        { role: "assistant", content: "b".repeat(100) },
        { role: "user", content: "c".repeat(100) },
        { role: "assistant", content: "d".repeat(100) },
      ]);

      expect(await loop.compact()).toBe(true);

      // 压缩后真实请求从 [system, 摘要, 保留尾部] 出发
      await loop.runTurn("hi");
      const request = llm.requests[1]!;
      expect(request[0]).toEqual({ role: "system", content: "sys" });
      expect(request.some((m) => m.role === "user" && m.content.includes("handoff"))).toBe(true);
      expect(request.at(-1)).toEqual({ role: "user", content: "hi" });

      // 压缩是事实:进 wire 事件流(runTurn 收尾 flush 已落盘)
      expect(events.find((e) => e.type === "context.compacted")).toMatchObject({
        type: "context.compacted",
        summary: "handoff",
      });
      const rows = await new WireService(wirePath).readAll();
      expect(rows.some((r) => r.event.type === "context.compacted")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to sliding-window truncation when the summary call fails", async () => {
    const bus = new EventBus();
    const events: EngineEvent[] = [];
    bus.on("context.compacted", (p) => events.push({ type: "context.compacted", ...p }));
    bus.on("turn.ended", (p) => events.push({ type: "turn.ended", ...p }));

    const requests: Message[][] = [];
    let calls = 0;
    const flaky = {
      async *request(messages: Message[], _tools: ToolSpec[]): AsyncIterable<ModelEvent> {
        requests.push(structuredClone(messages));
        calls += 1;
        if (calls === 1) throw new Error("summary call down");
        yield { type: "text", text: "ok" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as LLMRequester;

    const loop = new Loop({
      llm: flaky,
      executor: new ToolExecutor(),
      bus,
      systemPrompt: "sys",
      contextTokenBudget: 100,
    });
    loop.loadHistory([
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "c".repeat(100) },
      { role: "assistant", content: "d".repeat(100) },
    ]);

    await loop.runTurn("hi");

    // 摘要调用失败 → 不发布压缩事件,真实请求从截断窗口出发
    expect(events.some((e) => e.type === "context.compacted")).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]![0]).toEqual({ role: "system", content: "sys" });
    expect(requests[1]!.at(-1)).toEqual({ role: "user", content: "hi" });
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", reason: "finish" });
  });
});
