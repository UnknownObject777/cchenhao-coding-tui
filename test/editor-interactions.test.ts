import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { assembleTui, type TuiAppInfo } from "../src/tui/app.ts";
import { createTuiHarness, type TuiHarness } from "./helpers/tui-harness.ts";

/** #21 slash 补全 + #22 多行键位语义（pi-tui Editor 能力的行为验证）。 */

describe("editor interactions", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("editor-test-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setupApp(): Promise<TuiHarness> {
    const agent = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });
    const h = createTuiHarness(100, 30);
    const info: TuiAppInfo = { toolName: "mini-agent", version: "0.0.0-test", model: agent.model, cwd: dir };
    assembleTui(h.tui, agent, info, () => {});
    await h.tui.start();
    return h;
  }

  it("/ prefix offers slash command completions (#21)", async () => {
    const h = await setupApp();
    h.terminal.sendInput("/cl");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("clear");
      },
      { timeout: 3000, interval: 50 },
    );
    expect(h.viewport()).toContain("清空对话记录");
  });

  it("ctrl+j inserts a newline without submitting; enter submits joined lines (#22)", async () => {
    const h = await setupApp();
    h.terminal.sendInput("第一行");
    h.terminal.sendInput("\n"); // ctrl+j = pi-tui 的换行键位
    h.terminal.sendInput("第二行");
    await h.render();
    let vp = h.viewport();
    expect(vp).toContain("第一行");
    expect(vp).toContain("第二行");
    // 未提交：没有用户消息块
    expect(vp).not.toContain("✨");

    h.terminal.sendInput("\r");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("✨");
      },
      { timeout: 3000, interval: 50 },
    );
  });

  it("shift+enter also inserts a newline without submitting (#22)", async () => {
    const h = await setupApp();
    h.terminal.sendInput("第一行");
    h.terminal.sendInput("\u{1B}[13;2~"); // kitty 序列的 shift+enter（pi-tui keybindings 默认换行键位之一）
    h.terminal.sendInput("第二行");
    await h.render();
    expect(h.viewport()).toContain("第二行");
    expect(h.viewport()).not.toContain("✨");
  });

  it("bracketed multi-line paste does not submit (#22)", async () => {
    const h = await setupApp();
    h.terminal.sendInput("\u{1B}[200~粘贴第一行\n粘贴第二行\u{1B}[201~");
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("粘贴第一行");
    expect(vp).not.toContain("✨"); // 粘贴不误提交
  });
});
