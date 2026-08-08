import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type EngineEvent } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import { Loop } from "../src/engine/loop.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { WireService } from "../src/engine/wire.ts";

function setup(script: ConstructorParameters<typeof FakeLLM>[0], wirePath?: string) {
  const bus = new EventBus();
  const events: EngineEvent[] = [];
  bus.on("turn.started", (p) => events.push({ type: "turn.started", ...p }));
  bus.on("assistant.delta", (p) => events.push({ type: "assistant.delta", ...p }));
  bus.on("tool.call", (p) => events.push({ type: "tool.call", ...p }));
  bus.on("tool.result", (p) => events.push({ type: "tool.result", ...p }));
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
    ...(wirePath ? { wire: new WireService(wirePath) } : {}),
  });
  return { loop, events, llm };
}

describe("loop", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-test-"));
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

    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "tool.call",
      "tool.result",
      "assistant.delta",
      "turn.ended",
    ]);
    expect(events[1]).toEqual({ type: "assistant.delta", text: "Let me look. " });
    expect(events[2]).toEqual({
      type: "tool.call",
      id: "c1",
      name: "read_file",
      args: { path: "a.txt" },
    });
    expect(events[3]).toEqual({
      type: "tool.result",
      id: "c1",
      name: "read_file",
      ok: true,
      output: "contents of a.txt",
    });
    expect(events[5]).toEqual({ type: "turn.ended", turnId: 1, reason: "finish" });
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

    expect(events.map((e) => e.type)).toEqual([
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
});
