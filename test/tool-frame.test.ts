import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "../src/bootstrap.ts";
import { EventBus } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import { Loop } from "../src/engine/loop.ts";
import { registerBuiltinTools } from "../src/engine/tools/builtins.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { WireService } from "../src/engine/wire.ts";
import { assembleTui, type TuiAppInfo } from "../src/tui/app.ts";
import { createTuiHarness } from "./helpers/tui-harness.ts";

/** #24：工具帧默认折叠摘要、ctrl+o 展开全文、超长输出截断显示。 */

// 50 行内容经 write_file + read_file 产出（不走 shell——cmd/sh 的引号与括号语义不通用）
const LONG_TEXT = Array.from({ length: 50 }, (_, i) => `line${i + 100}`).join("\n");

describe("tool frame collapse/expand (#24)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("tool-frame-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collapses by default, expands and re-collapses on ctrl+o", async () => {
    const bus = new EventBus();
    const executor = new ToolExecutor();
    registerBuiltinTools(executor, dir);
    const llm = new FakeLLM([
      [
        { type: "tool_call", id: "c1", name: "write_file", args: { path: "big.txt", content: LONG_TEXT } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "tool_call", id: "c2", name: "read_file", args: { path: "big.txt" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "text", text: "跑完了" }, { type: "finish", reason: "stop" }],
    ]);
    const loop = new Loop({ llm, executor, bus, systemPrompt: "" });
    const agent: Agent = {
      loop,
      bus,
      wire: new WireService(join(dir, "wire.jsonl")),
      workspace: dir,
      model: "fake-llm",
      sessionPath: join(dir, "wire.jsonl"),
      history: [],
      approvalMemory: [],
      systemPrompt: "",
    };

    const h = createTuiHarness(100, 40);
    const info: TuiAppInfo = { toolName: "mini-agent", version: "0.0.0-test", model: "fake-llm", cwd: dir, approvalMode: "interactive" };
    assembleTui(h.tui, agent, info, () => {});
    await h.tui.start();

    h.terminal.sendInput("跑一下");
    await h.render();
    h.terminal.sendInput("\r");

    // run_command 是 confirm 级 → 审批帧 → y 放行
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("等待审批");
      },
      { timeout: 5000, interval: 50 },
    );
    h.terminal.sendInput("y");

    // 折叠态：100 可见、149 不可见、有 more-lines 与展开提示
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("跑完了");
      },
      { timeout: 5000, interval: 50 },
    );
    let vp = h.viewport();
    expect(vp).toContain("100");
    expect(vp).not.toContain("149");
    expect(vp).toContain("more lines");
    expect(vp).toContain("ctrl+o 展开");

    // ctrl+o 展开：149 可见
    h.terminal.sendInput("\u{F}");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("149");
      },
      { timeout: 5000, interval: 50 },
    );
    expect(h.viewport()).toContain("ctrl+o 折叠");

    // 再按折叠回去
    h.terminal.sendInput("\u{F}");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).not.toContain("149");
      },
      { timeout: 5000, interval: 50 },
    );
  });
});
