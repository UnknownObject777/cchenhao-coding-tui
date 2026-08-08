import { describe, expect, it } from "vitest";

import type { Component } from "../vendor/pi-tui/src/index.ts";
import { AssistantMessageComponent } from "../src/tui/components/messages/assistant-message.ts";
import { ToolCallComponent } from "../src/tui/components/messages/tool-call.ts";
import { UserMessageComponent } from "../src/tui/components/messages/user-message.ts";
import { createTuiHarness, type TuiHarness } from "./helpers/tui-harness.ts";

async function mountAll(...components: Component[]): Promise<TuiHarness> {
  const h = createTuiHarness(80, 24);
  for (const c of components) h.tui.addChild(c);
  await h.tui.start();
  await h.render();
  return h;
}

describe("UserMessageComponent", () => {
  it("renders the user text with a bullet", async () => {
    const h = await mountAll(new UserMessageComponent("帮我写个脚本"));
    const vp = h.viewport();
    expect(vp).toContain("帮我写个脚本");
    expect(vp).toContain("✨");
    h.stop();
  });

  it("wraps long text within the viewport width", async () => {
    const h = await mountAll(new UserMessageComponent("x".repeat(200)));
    for (const line of h.terminal.getViewport()) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    h.stop();
  });
});

describe("AssistantMessageComponent", () => {
  it("renders nothing before any content arrives", async () => {
    const h = await mountAll(new AssistantMessageComponent());
    expect(h.viewport().trim()).toBe("");
    h.stop();
  });

  it("renders markdown content with the assistant bullet", async () => {
    const c = new AssistantMessageComponent();
    c.updateContent("# 结论\n正文 **加粗**");
    const h = await mountAll(c);
    const vp = h.viewport();
    expect(vp).toContain("结论");
    expect(vp).toContain("正文");
    expect(vp).toContain("●");
    h.stop();
  });

  it("updates in place as streaming deltas accumulate", async () => {
    const c = new AssistantMessageComponent();
    c.updateContent("hello");
    const h = await mountAll(c);
    expect(h.viewport()).toContain("hello");

    c.updateContent("hello world");
    await h.render();
    expect(h.viewport()).toContain("hello world");
    h.stop();
  });
});

describe("ToolCallComponent", () => {
  it("renders tool name and key argument while pending", async () => {
    const h = await mountAll(new ToolCallComponent("read_file", { path: "src/main.ts" }));
    const vp = h.viewport();
    expect(vp).toContain("read_file");
    expect(vp).toContain("src/main.ts");
    h.stop();
  });

  it("renders success mark and output preview after setResult", async () => {
    const c = new ToolCallComponent("run_command", { command: "npm test" });
    const h = await mountAll(c);
    c.setResult(true, "line1\nline2\nall green");
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("✓");
    expect(vp).toContain("line1");
    expect(vp).toContain("all green");
    h.stop();
  });

  it("renders failure mark and error output", async () => {
    const c = new ToolCallComponent("write_file", { path: "/etc/x", content: "y" });
    const h = await mountAll(c);
    c.setResult(false, "permission denied");
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("✗");
    expect(vp).toContain("permission denied");
    h.stop();
  });

  it("truncates long output to a fixed preview with a more-lines marker", async () => {
    const c = new ToolCallComponent("run_command", { command: "seq 1 50" });
    const output = Array.from({ length: 50 }, (_, i) => `row${i + 1}`).join("\n");
    const h = await mountAll(c);
    c.setResult(true, output);
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("row1");
    expect(vp).not.toContain("row50");
    expect(vp).toMatch(/….*45|45.*more/);
    h.stop();
  });
});
