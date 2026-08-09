import { describe, expect, it } from "vitest";

import {
  COMPACT_HIGH_WATER,
  COMPACT_LOW_WATER,
  COMPACT_TAIL_FRACTION,
  CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  pickRetainedTail,
  splitForCompaction,
  SUMMARY_MARKER,
  summaryMessage,
  truncateToWindow,
} from "../src/engine/context.ts";
import { EventBus, type EngineEvent } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import type { Message } from "../src/engine/llm/types.ts";
import { Loop } from "../src/engine/loop.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";

describe("water marks (#57 rename)", () => {
  it("high/low water are 80%/60% of the budget", () => {
    expect(COMPACT_HIGH_WATER).toBe(0.8);
    expect(COMPACT_LOW_WATER).toBe(0.6);
  });
});

describe("estimateTokens (#32)", () => {
  it("is chars/4 including tool call args", () => {
    const messages: Message[] = [
      { role: "system", content: "x".repeat(40) },
      { role: "user", content: "y".repeat(40) },
    ];
    expect(estimateTokens(messages)).toBe(20);

    const withTool: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read_file", args: { path: "aaaa" } }] },
    ];
    // name 9 + JSON {"path":"aaaa"} 15 = 24 chars → 6 tokens
    expect(estimateTokens(withTool)).toBe(6);
  });
});

describe("truncateToWindow (#31)", () => {
  const big = (n: number): string => "z".repeat(n);

  it("keeps system and the newest messages, drops the oldest", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big(400) },
      { role: "assistant", content: big(400) },
      { role: "user", content: "recent" },
    ];
    const out = truncateToWindow(messages, 120); // 120 tokens ≈ 480 chars
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out.at(-1)).toEqual({ role: "user", content: "recent" });
    expect(out.length).toBeLessThan(messages.length);
    expect(estimateTokens(out)).toBeLessThanOrEqual(120);
  });

  it("never splits an assistant toolCalls group from its tool replies", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big(200) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read_file", content: big(200) },
      { role: "user", content: "latest" },
    ];
    const out = truncateToWindow(messages, 30); // 只装得下 system + latest
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "latest" },
    ]);
    // 没有孤儿 tool 消息，也没有缺回复的 toolCalls
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("keeps the newest group even when it alone exceeds the budget", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big(10000) },
    ];
    const out = truncateToWindow(messages, 100);
    expect(out.at(-1)).toEqual({ role: "user", content: big(10000) });
  });
});

describe("compaction helpers (#57)", () => {
  const big = (n: number): string => "z".repeat(n);

  it("pickRetainedTail keeps the newest whole groups within the tail budget", () => {
    const messages: Message[] = [
      { role: "user", content: big(200) }, // 50 tokens
      { role: "assistant", content: big(200) }, // 50 tokens
      { role: "user", content: "recent" }, // ~1 token
    ];
    const tail = pickRetainedTail(messages, 60);
    expect(tail).toEqual([
      { role: "assistant", content: big(200) },
      { role: "user", content: "recent" },
    ]);
    expect(estimateTokens(tail)).toBeLessThanOrEqual(60);
  });

  it("pickRetainedTail never splits a toolCalls group from its tool replies", () => {
    const messages: Message[] = [
      { role: "user", content: big(400) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read_file", content: big(200) },
      { role: "user", content: "latest" },
    ];
    const tail = pickRetainedTail(messages, 60);
    expect(tail).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read_file", content: big(200) },
      { role: "user", content: "latest" },
    ]);
  });

  it("pickRetainedTail keeps the newest group even when it alone busts the budget", () => {
    const messages: Message[] = [
      { role: "user", content: big(10000) },
      { role: "user", content: "newest" },
    ];
    const tail = pickRetainedTail(messages, 10);
    expect(tail).toEqual([{ role: "user", content: "newest" }]);
  });

  it("splitForCompaction separates system, summarizable head and retained tail", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big(200) },
      { role: "user", content: "recent" },
    ];
    const { system, head, tail } = splitForCompaction(messages, 10);
    expect(system).toEqual([{ role: "system", content: "sys" }]);
    expect(head).toEqual([{ role: "user", content: big(200) }]);
    expect(tail).toEqual([{ role: "user", content: "recent" }]);
  });

  it("splitForCompaction yields an empty head when everything fits the tail", () => {
    const messages: Message[] = [{ role: "system", content: "sys" }, { role: "user", content: "only" }];
    const { head } = splitForCompaction(messages, 1000);
    expect(head).toEqual([]);
  });

  it("summaryMessage carries the marker and the summary text", () => {
    expect(summaryMessage("handoff")).toEqual({
      role: "user",
      content: `${SUMMARY_MARKER}\nhandoff`,
    });
  });
});

describe("loop context window enforcement (#31)", () => {
  it("compacts before the request when over budget and reports usage", async () => {
    const bus = new EventBus();
    const events: EngineEvent[] = [];
    bus.on("context.usage", (p) => events.push({ type: "context.usage", ...p }));
    bus.on("context.compacted", (p) => events.push({ type: "context.compacted", ...p }));
    bus.on("turn.ended", (p) => events.push({ type: "turn.ended", ...p }));

    // 脚本第 0 轮 = 摘要调用,第 1 轮 = 真实请求
    const llm = new FakeLLM([
      [{ type: "text", text: "handoff summary" }, { type: "finish", reason: "stop" }],
      [{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }],
    ]);
    const loop = new Loop({
      llm,
      executor: new ToolExecutor(),
      bus,
      systemPrompt: "sys",
      contextTokenBudget: 100,
    });
    // 预算 100：80 触发压缩。灌 4 条 100 字符（25 tokens）历史 + prompt ≈ 102 tokens
    loop.loadHistory([
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "c".repeat(100) },
      { role: "assistant", content: "d".repeat(100) },
    ]);

    await loop.runTurn("hi");

    // 摘要调用先发生：第一个请求 = 摘要系统 prompt + 可压缩头部
    const summaryRequest = llm.requests[0]!;
    expect(summaryRequest[0]!.role).toBe("system");
    expect(summaryRequest[0]!.content).toContain("压缩");
    // 真实请求从压缩后的状态出发：system + 摘要 + 保留尾部 + 新 prompt
    const request = llm.requests[1]!;
    expect(request[0]).toEqual({ role: "system", content: "sys" });
    expect(request.some((m) => m.role === "user" && m.content.includes("handoff summary"))).toBe(true);
    expect(request.at(-1)).toEqual({ role: "user", content: "hi" });
    expect(events.some((e) => e.type === "context.compacted")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", reason: "finish" });
  });

  it("ends with a /clear hint when a single message busts the budget", async () => {
    const bus = new EventBus();
    let error: string | undefined;
    bus.on("turn.ended", (p) => {
      error = p.error;
    });

    const llm = new FakeLLM([[{ type: "finish", reason: "stop" }]]);
    const loop = new Loop({
      llm,
      executor: new ToolExecutor(),
      bus,
      systemPrompt: "sys",
      contextTokenBudget: 10,
    });

    await loop.runTurn("x".repeat(1000));

    expect(error).toContain("context overflow");
    expect(error).toContain("/clear");
  });
});

describe("footer context usage (#32)", () => {
  it("shows usage after setUsage and warns near the budget", async () => {
    const { FooterComponent, formatTokenCount } = await import("../src/tui/components/chrome/footer.ts");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(CONTEXT_TOKEN_BUDGET)).toBe("256k");

    const footer = new FooterComponent({ model: "m", cwd: "/p", approvalLabel: "审批:交互" });
    expect(footer.render(80)[0]).not.toContain("ctx");
    footer.setUsage(12000, 256000);
    expect(footer.render(80)[0]).toContain("ctx 12k/256k");
  });

  it("switches to the warning color near the budget", async () => {
    const { default: chalk } = await import("chalk");
    chalk.level = 3;
    const { FooterComponent } = await import("../src/tui/components/chrome/footer.ts");
    const footer = new FooterComponent({ model: "m", cwd: "/p", approvalLabel: "审批:交互" });
    footer.setUsage(12000, 256000);
    const calm = footer.render(80)[0]!;
    footer.setUsage(200000, 256000);
    const warned = footer.render(80)[0]!;
    expect(warned).toContain("ctx 200k/256k");
    expect(warned).not.toBe(calm); // warning 色上了 ANSI
  });
});
