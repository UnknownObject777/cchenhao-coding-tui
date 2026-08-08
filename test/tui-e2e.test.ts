import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { assembleTui, type TuiAppInfo } from "../src/tui/app.ts";
import { createTuiHarness } from "./helpers/tui-harness.ts";

/**
 * #18 端到端冒烟：bootstrap 装配 Engine → TUI（fake LLM），
 * VirtualTerminal 里提交一条消息 → 视口出现用户块 + 工具帧 + 回复块。
 */

describe("TUI end-to-end smoke (fake LLM)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tui-e2e-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a full turn with tool frames in the viewport", async () => {
    const agent = await bootstrap({ workspace: dir, fake: true });
    const h = createTuiHarness(80, 24);
    const info: TuiAppInfo = { toolName: "mini-agent", version: "0.0.0-test", model: agent.model, cwd: dir };
    assembleTui(h.tui, agent, info, () => {});
    await h.tui.start();
    await h.render();

    // welcome 已上屏
    expect(h.viewport()).toContain("mini-agent");
    // loader 在 turn 开始前不亮相（pi-tui Loader 构造即 start）
    expect(h.viewport()).not.toContain("Thinking");

    h.terminal.sendInput("写个 hello 文件");
    await h.render();
    h.terminal.sendInput("\r");

    // fake 脚本：write_file → read_file → 总结；等 turn 收尾
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("FAKE_LLM 预置脚本");
      },
      { timeout: 5000, interval: 50 },
    );

    const vp = h.viewport();
    expect(vp).toContain("写个 hello 文件"); // 用户块
    expect(vp).toContain("write_file"); // 工具帧
    expect(vp).toContain("read_file");
    expect(vp).toContain("✓"); // 工具成功
    expect(vp).toContain("fake-llm"); // footer 模型名

    // 工具真实地落了盘
    expect(existsSync(join(dir, "hello.txt"))).toBe(true);
    // wire 日志记录了全程
    expect((await agent.wire.readAll()).length).toBeGreaterThan(0);
  });

  it("Ctrl+C triggers the exit hook", async () => {
    const agent = await bootstrap({ workspace: dir, fake: true });
    const h = createTuiHarness(80, 24);
    const info: TuiAppInfo = { toolName: "mini-agent", version: "0.0.0-test", model: agent.model, cwd: dir };
    const onExit = vi.fn();
    assembleTui(h.tui, agent, info, onExit);
    await h.tui.start();

    h.terminal.sendInput("\x03");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });
});
