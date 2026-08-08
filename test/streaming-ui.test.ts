import { describe, expect, it } from "vitest";

import { EventBus } from "../src/engine/events.ts";
import { FooterComponent } from "../src/tui/components/chrome/footer.ts";
import { createLoader } from "../src/tui/components/chrome/loader.ts";
import { WelcomeComponent } from "../src/tui/components/chrome/welcome.ts";
import { StreamingUiController } from "../src/tui/controllers/streaming-ui.ts";
import { Container } from "../vendor/pi-tui/src/index.ts";
import { createTuiHarness } from "./helpers/tui-harness.ts";

async function mountWithController() {
  const h = createTuiHarness(80, 24);
  const bus = new EventBus();
  const chat = new Container();
  const loader = createLoader(h.tui);
  h.tui.addChild(chat);
  h.tui.addChild(loader);
  const controller = new StreamingUiController({
    bus,
    chat,
    loader,
    requestRender: () => h.tui.requestRender(true),
  });
  controller.start();
  await h.tui.start();
  return { h, bus, chat, loader, controller };
}

describe("StreamingUiController", () => {
  it("shows the loader when a turn starts", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    await h.render();
    expect(h.viewport()).toContain("Thinking");
  });

  it("accumulates assistant deltas into one markdown block", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("assistant.delta", { text: "你好" });
    bus.emit("assistant.delta", { text: "，世界" });
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("你好，世界");
    expect(vp).not.toContain("Thinking");
  });

  it("renders tool frames and their results between text blocks", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("assistant.delta", { text: "先读文件" });
    bus.emit("tool.call", { id: "t1", name: "read_file", args: { path: "a.ts" } });
    bus.emit("tool.result", { id: "t1", name: "read_file", ok: true, output: "file body" });
    bus.emit("assistant.delta", { text: "读完了" });
    bus.emit("turn.ended", { turnId: 1, reason: "finish" });
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("先读文件");
    expect(vp).toContain("read_file");
    expect(vp).toContain("✓");
    expect(vp).toContain("file body");
    expect(vp).toContain("读完了");
    // 工具帧在两个文本块之间：后一段文本属于新 assistant 块
    expect(vp.indexOf("先读文件")).toBeLessThan(vp.indexOf("read_file"));
    expect(vp.indexOf("read_file")).toBeLessThan(vp.indexOf("读完了"));
  });

  it("surfaces turn errors as an error message", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("turn.ended", { turnId: 1, reason: "error", error: "boom happened" });
    await h.render();
    expect(h.viewport()).toContain("boom happened");
  });

  it("stops the loader when the turn ends", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    await h.render();
    bus.emit("turn.ended", { turnId: 1, reason: "finish" });
    await h.render();
    expect(h.viewport()).not.toContain("Thinking");
  });

  it("restarts the loader on the same instance after hide (turn 2)", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "one" });
    await h.render();
    bus.emit("turn.ended", { turnId: 1, reason: "finish" });
    await h.render();
    expect(h.viewport()).not.toContain("Thinking");

    bus.emit("turn.started", { turnId: 2, prompt: "two" });
    await h.render();
    expect(h.viewport()).toContain("Thinking");
  });

  it("marks failed tool results with ✗", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("tool.call", { id: "t1", name: "write_file", args: { path: "a.ts" } });
    bus.emit("tool.result", { id: "t1", name: "write_file", ok: false, output: "disk full" });
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("✗");
    expect(vp).toContain("disk full");
  });

  it("renders think streams as a folded dim block, separate from the reply (#20)", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("assistant.think", { text: "先想想第一步" });
    bus.emit("assistant.think", { text: "，再动手" });
    await h.render();
    let vp = h.viewport();
    expect(vp).toContain("thinking");
    expect(vp).toContain("先想想第一步");

    bus.emit("assistant.delta", { text: "正式回复" });
    await h.render();
    vp = h.viewport();
    // 思考折叠块仍在，正文独立成块，且摘要不混入正文
    expect(vp).toContain("thinking");
    expect(vp).toContain("正式回复");
    expect(vp.indexOf("thinking")).toBeLessThan(vp.indexOf("正式回复"));
  });

  it("folds long think content to a one-line preview", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("assistant.think", { text: `${"很长的思考".repeat(30)}\n第二行` });
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("thinking");
    expect(vp).toContain("…");
    expect(vp).not.toContain("第二行");
  });

  it("late think deltas update the original block in place (stays above the reply)", async () => {
    const { h, bus } = await mountWithController();
    bus.emit("turn.started", { turnId: 1, prompt: "hi" });
    bus.emit("assistant.think", { text: "先想" });
    bus.emit("assistant.delta", { text: "正文" });
    bus.emit("assistant.think", { text: "，迟到的思考" });
    await h.render();
    const vp = h.viewport();
    // 只有一个 thinking 块，且在正文上方；迟到的内容并进去了
    expect(vp.match(/thinking/g)?.length).toBe(1);
    expect(vp).toContain("迟到的思考");
    expect(vp.indexOf("thinking")).toBeLessThan(vp.indexOf("正文"));
  });
});

describe("chrome components", () => {
  it("footer renders model, cwd and approval mode (#48)", async () => {
    const h = createTuiHarness(80, 24);
    h.tui.addChild(new FooterComponent({ model: "kimi-for-coding", cwd: "D:/proj", approvalLabel: "审批:规则" }));
    await h.tui.start();
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("kimi-for-coding");
    expect(vp).toContain("D:/proj");
    expect(vp).toContain("审批:规则");
    h.stop();
  });

  it("welcome renders tool name, model, cwd and a hint", async () => {
    const h = createTuiHarness(80, 24);
    h.tui.addChild(
      new WelcomeComponent({ toolName: "mini-agent", version: "0.1.0", model: "kimi-for-coding", cwd: "D:/proj" }),
    );
    await h.tui.start();
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("mini-agent");
    expect(vp).toContain("0.1.0");
    expect(vp).toContain("kimi-for-coding");
    expect(vp).toContain("D:/proj");
    h.stop();
  });
});
