import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { assembleTui, type TuiAppInfo } from "../src/tui/app.ts";
import { createTuiHarness, type TuiHarness } from "./helpers/tui-harness.ts";

/** #28：审批 UI 接入 TUI——loop 暂停等 y/n/a/esc，消息区内联审批帧。 */

describe("TUI approval flow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tui-approval-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setupApp(): Promise<{ h: TuiHarness; workspace: string }> {
    const agent = await bootstrap({ workspace: dir, fake: true });
    const h = createTuiHarness(100, 30);
    const info: TuiAppInfo = { toolName: "mini-agent", version: "0.0.0-test", model: agent.model, cwd: dir };
    assembleTui(h.tui, agent, info, () => {});
    await h.tui.start();
    return { h, workspace: dir };
  }

  async function submitAndWaitForApproval(h: TuiHarness): Promise<void> {
    h.terminal.sendInput("演示");
    await h.render();
    h.terminal.sendInput("\r");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("等待审批");
      },
      { timeout: 5000, interval: 50 },
    );
  }

  it("pauses the turn at an approval frame listing the tool and key hints", async () => {
    const { h } = await setupApp();
    await submitAndWaitForApproval(h);
    const vp = h.viewport();
    expect(vp).toContain("write_file");
    expect(vp).toContain("[y]");
    expect(vp).toContain("[n]");
    expect(vp).toContain("[a]");
    // turn 暂停：总结文本还没出现
    expect(vp).not.toContain("FAKE_LLM 预置脚本");
  });

  it("y approves and the turn resumes to completion", async () => {
    const { h } = await setupApp();
    await submitAndWaitForApproval(h);

    h.terminal.sendInput("y");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("FAKE_LLM 预置脚本");
      },
      { timeout: 5000, interval: 50 },
    );

    expect(h.viewport()).toContain("已允许");
    expect(existsSync(join(dir, "hello.txt"))).toBe(true);
  });

  it("n denies and the loop feeds the denial back instead of executing", async () => {
    const { h } = await setupApp();
    await submitAndWaitForApproval(h);

    h.terminal.sendInput("n");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("已拒绝");
      },
      { timeout: 5000, interval: 50 },
    );

    expect(existsSync(join(dir, "hello.txt"))).toBe(false);
    // read_file 是只读自动放行，turn 继续走完
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("FAKE_LLM 预置脚本");
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it("escape denies as well", async () => {
    const { h } = await setupApp();
    await submitAndWaitForApproval(h);
    h.terminal.sendInput("\u{1B}");
    await vi.waitFor(
      async () => {
        await h.render();
        expect(h.viewport()).toContain("已拒绝");
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it("keystrokes without a pending approval go to the editor untouched", async () => {
    const { h } = await setupApp();
    h.terminal.sendInput("y");
    await h.render();
    // 没有审批帧被创建，y 进了 editor 文本
    expect(h.viewport()).not.toContain("等待审批");
  });
});
