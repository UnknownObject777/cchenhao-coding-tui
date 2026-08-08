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
    const path = store.create();
    expect(path).toContain(workspaceSlug("D:/找工作/my proj"));
    expect(path).toMatch(/\.jsonl$/);
    expect(store.create()).not.toBe(path); // 唯一
  });

  it("latest() returns the newest session file, undefined when empty", async () => {
    const store = new SessionStore(dir, "D:/proj");
    expect(await store.latest()).toBeUndefined();

    const first = store.create();
    await new WireService(first).append({ type: "turn.started", turnId: 1, prompt: "one" });
    const newest = await store.latest();
    expect(newest).toBe(first);
  });

  it("different workspaces get different directories", async () => {
    const a = new SessionStore(dir, "D:/proj-a");
    const b = new SessionStore(dir, "D:/proj-b");
    await new WireService(a.create()).append({ type: "turn.started", turnId: 1, prompt: "x" });
    expect(await b.latest()).toBeUndefined(); // 互不串扰
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

  it("print-style bootstrap (no session flag) starts a fresh session file", async () => {
    const first = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });
    await first.loop.runTurn("第一轮");
    const fresh = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });

    expect(fresh.sessionPath).not.toBe(first.sessionPath);
    expect(fresh.history).toEqual([]);
  });
});
