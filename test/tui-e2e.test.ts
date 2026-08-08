import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
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
    dir = makeTempDir("tui-e2e-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setupApp(onExit: () => void = () => {}) {
    const agent = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });
    const h = createTuiHarness(80, 24);
    const info: TuiAppInfo = { toolName: "mini-agent", version: "0.0.0-test", model: agent.model, cwd: dir, approvalMode: "interactive" };
    assembleTui(h.tui, agent, info, onExit);
    await h.tui.start();
    return { agent, h };
  }

  it("runs a full turn with tool frames in the viewport", async () => {
    const { agent, h } = await setupApp();
    await h.render();

    // welcome 已上屏
    expect(h.viewport()).toContain("mini-agent");
    // loader 在 turn 开始前不亮相（pi-tui Loader 构造即 start）
    expect(h.viewport()).not.toContain("Thinking");

    h.terminal.sendInput("写个 hello 文件");
    await h.render();
    h.terminal.sendInput("\r");

    // write_file 触发审批帧（#28 起 TUI 有审批闸），答 y 放行
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("等待审批");
      },
      { timeout: 5000, interval: 50 },
    );
    h.terminal.sendInput("y");

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
    const onExit = vi.fn();
    const { h } = await setupApp(onExit);

    h.terminal.sendInput("\x03");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });
});
