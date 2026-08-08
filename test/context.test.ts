import { describe, expect, it } from "vitest";

import {
  CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  truncateToWindow,
} from "../src/engine/context.ts";
import { EventBus, type EngineEvent } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import type { Message } from "../src/engine/llm/types.ts";
import { Loop } from "../src/engine/loop.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";

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

describe("loop context window enforcement (#31)", () => {
  it("truncates before the request and reports usage", async () => {
    const bus = new EventBus();
    const events: EngineEvent[] = [];
    bus.on("context.usage", (p) => events.push({ type: "context.usage", ...p }));
    bus.on("turn.ended", (p) => events.push({ type: "turn.ended", ...p }));

    const llm = new FakeLLM([[{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }]]);
    const loop = new Loop({
      llm,
      executor: new ToolExecutor(),
      bus,
      systemPrompt: "sys",
      contextTokenBudget: 100,
    });
    // 预算 100 tokens：80 触发截断，60 目标。灌 3 条 800 字符（200 tokens）的历史
    loop.loadHistory([
      { role: "user", content: "a".repeat(800) },
      { role: "assistant", content: "b".repeat(800) },
      { role: "user", content: "c".repeat(800) },
    ]);

    await loop.runTurn("hi");

    // 截断后请求里的消息应显著少于灌入的
    const request = llm.requests[0]!;
    expect(request.length).toBeLessThan(4);
    expect(request[0]).toEqual({ role: "system", content: "sys" });
    expect(events.some((e) => e.type === "context.usage")).toBe(true);
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

    const footer = new FooterComponent({ model: "m", cwd: "/p" });
    expect(footer.render(80)[0]).not.toContain("ctx");
    footer.setUsage(12000, 256000);
    expect(footer.render(80)[0]).toContain("ctx 12k/256k");
  });

  it("switches to the warning color near the budget", async () => {
    const { default: chalk } = await import("chalk");
    chalk.level = 3;
    const { FooterComponent } = await import("../src/tui/components/chrome/footer.ts");
    const footer = new FooterComponent({ model: "m", cwd: "/p" });
    footer.setUsage(12000, 256000);
    const calm = footer.render(80)[0]!;
    footer.setUsage(200000, 256000);
    const warned = footer.render(80)[0]!;
    expect(warned).toContain("ctx 200k/256k");
    expect(warned).not.toBe(calm); // warning 色上了 ANSI
  });
});
