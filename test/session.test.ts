import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { EventBus } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import { Loop } from "../src/engine/loop.ts";
import { SessionStore, workspaceSlug } from "../src/engine/session.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { alwaysMemoryFrom } from "../src/engine/approval/composed-gate.ts";
import { Rebuilder, WireService } from "../src/engine/wire.ts";
import type { EngineEvent } from "../src/engine/events.ts";

function setupLoop() {
  const llm = new FakeLLM([[{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }]]);
  const loop = new Loop({ llm, executor: new ToolExecutor(), bus: new EventBus(), systemPrompt: "you are a toy" });
  return { loop, llm };
}

describe("SessionStore (#30)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates session files under a workspace-slug directory", () => {
    const store = new SessionStore(dir, "D:/找工作/my proj");
    const path = store.createPath();
    expect(path).toContain(workspaceSlug("D:/找工作/my proj"));
    expect(path).toMatch(/\.jsonl$/);
    expect(store.createPath()).not.toBe(path); // 唯一
  });

  it("latest() returns the newest session file, undefined when empty", async () => {
    const store = new SessionStore(dir, "D:/proj");
    expect(await store.latestPath()).toBeUndefined();

    const first = store.createPath();
    await new WireService(first).append({ type: "turn.started", turnId: 1, prompt: "one" });
    const newest = await store.latestPath();
    expect(newest).toBe(first);
  });

  it("different workspaces get different directories", async () => {
    const a = new SessionStore(dir, "D:/proj-a");
    const b = new SessionStore(dir, "D:/proj-b");
    await new WireService(a.createPath()).append({ type: "turn.started", turnId: 1, prompt: "x" });
    expect(await b.latestPath()).toBeUndefined(); // 互不串扰
  });

  it("slug does not collide on punctuation-only differences or drive letters", () => {
    expect(workspaceSlug("D:/my proj")).not.toBe(workspaceSlug("D:/my-proj"));
    expect(workspaceSlug("C:/proj")).not.toBe(workspaceSlug("D:/proj"));
  });

  it("print sessions are invisible to latest() (continue picks chat sessions only)", async () => {
    const store = new SessionStore(dir, "D:/proj");
    await new WireService(store.createPath("print")).append({ type: "turn.started", turnId: 1, prompt: "p" });
    expect(await store.latestPath()).toBeUndefined();
  });
});

describe("session resume into context (#29)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resume-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuildForContext restores protocol shapes with tool pairing", async () => {
    const events: EngineEvent[] = [
      { type: "turn.started", turnId: 1, prompt: "读一下 a.txt" },
      { type: "assistant.delta", text: "好的，" },
      { type: "assistant.delta", text: "我来读" },
      { type: "tool.call", id: "c1", name: "read_file", args: { path: "a.txt" } },
      { type: "approval.request", id: "c1", name: "read_file", args: { path: "a.txt" }, level: "confirm" },
      { type: "approval.decision", id: "c1", decision: "allow" },
      { type: "tool.result", id: "c1", name: "read_file", ok: true, output: "内容" },
      { type: "assistant.delta", text: "读完了" },
      { type: "turn.ended", turnId: 1, reason: "finish" },
    ];
    const wirePath = join(dir, "w.jsonl");
    const wire = new WireService(wirePath);
    for (const event of events) await wire.append(event);

    const messages = new Rebuilder().rebuildForContext(await wire.readAll());

    expect(messages).toEqual([
      { role: "user", content: "读一下 a.txt" },
      {
        role: "assistant",
        content: "好的，我来读",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "内容" },
      { role: "assistant", content: "读完了" },
    ]);
  });

  it("bootstrap continue feeds the rebuilt history into the loop context", async () => {
    // 第一段会话：跑一轮（fake 脚本固定）
    const first = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });
    await first.loop.runTurn("第一轮");

    // 重启：continue 恢复
    const resumed = await bootstrap({ workspace: dir, fake: true, session: "continue", sessionRoot: dir });

    expect(resumed.sessionPath).toBe(first.sessionPath); // 复用同一会话文件
    expect(resumed.history.length).toBeGreaterThan(0); // UI 展示通道
    expect(resumed.history[0]).toEqual({ role: "user", text: "第一轮" });
  });

  it("loadHistory prepends rebuilt messages after the system prompt", async () => {
    const { loop, llm } = setupLoop();
    loop.loadHistory([
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
    ]);
    await loop.runTurn("新问题");

    expect(llm.requests[0]).toEqual([
      { role: "system", content: "you are a toy" },
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
      { role: "user", content: "新问题" },
    ]);
  });

  it("interrupted sessions get synthesized tool replies so pairing stays valid", async () => {
    const wirePath = join(dir, "interrupted.jsonl");
    const wire = new WireService(wirePath);
    // 进程在 tool.result 之前被杀：没有 turn.ended、没有 result
    await wire.append({ type: "turn.started", turnId: 1, prompt: "干活" });
    await wire.append({ type: "tool.call", id: "c1", name: "run_command", args: { command: "make" } });

    const messages = new Rebuilder().rebuildForContext(await wire.readAll());

    expect(messages).toEqual([
      { role: "user", content: "干活" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "run_command", args: { command: "make" } }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        name: "run_command",
        content: "(session interrupted before tool result)",
      },
    ]);
  });

  it("always-memory is restored from wire approval events (#26 on resume)", async () => {
    const wirePath = join(dir, "mem.jsonl");
    const wire = new WireService(wirePath);
    await wire.append({ type: "approval.request", id: "c1", name: "run_command", args: { command: "npm install" }, level: "confirm" });
    await wire.append({ type: "approval.decision", id: "c1", decision: "always" });
    await wire.append({ type: "approval.request", id: "c2", name: "run_command", args: { command: "node x.js" }, level: "confirm" });
    await wire.append({ type: "approval.decision", id: "c2", decision: "allow" });

    const keys = alwaysMemoryFrom(await wire.readAll());

    expect(keys).toEqual(new Set(["run_command:npm install"]));
  });

  it("print-style bootstrap (no session flag) starts a fresh session file", async () => {
    const first = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });
    await first.loop.runTurn("第一轮");
    const fresh = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });

    expect(fresh.sessionPath).not.toBe(first.sessionPath);
    expect(fresh.history).toEqual([]);
  });
});
