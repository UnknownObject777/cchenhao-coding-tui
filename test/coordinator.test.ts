import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "../src/bootstrap.ts";
import { EventBus } from "../src/engine/events.ts";
import type { Loop } from "../src/engine/loop.ts";
import { TodoStore } from "../src/engine/todo.ts";
import { WireService } from "../src/engine/wire.ts";
import { parseSlashCommand } from "../src/tui/commands/parse.ts";
import { TuiCoordinator } from "../src/tui/coordinator.ts";
import { createEditorTheme } from "../src/tui/theme/pi-tui-theme.ts";
import { Container, Editor } from "../vendor/pi-tui/src/index.ts";
import { createTuiHarness } from "./helpers/tui-harness.ts";

describe("parseSlashCommand", () => {
  it("parses name and args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
    expect(parseSlashCommand("/delete  extra ")).toEqual({ name: "delete", args: "extra" });
  });

  it("returns undefined for non-commands", () => {
    expect(parseSlashCommand("clear")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
    expect(parseSlashCommand("")).toBeUndefined();
  });
});

interface CoordinatorFixture {
  coordinator: TuiCoordinator;
  bus: EventBus;
  runTurn: ReturnType<typeof vi.fn>;
  loopReset: ReturnType<typeof vi.fn>;
  loopCompact: ReturnType<typeof vi.fn>;
  wire: WireService;
  onExit: ReturnType<typeof vi.fn>;
  h: ReturnType<typeof createTuiHarness>;
  editor: Editor;
  chat: Container;
  dir: string;
}

async function setupCoordinator(): Promise<CoordinatorFixture> {
  const dir = makeTempDir("coordinator-test-");
  const h = createTuiHarness(80, 24);
  const bus = new EventBus();
  const chat = new Container();
  const editor = new Editor(h.tui, createEditorTheme());
  h.tui.addChild(chat);
  h.tui.addChild(editor);
  h.tui.setFocus(editor);

  const runTurn = vi.fn<(prompt: string) => Promise<void>>().mockResolvedValue(undefined);
  const loopReset = vi.fn();
  const loopCompact = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const wire = new WireService(join(dir, "wire.jsonl"));
  const agent = {
    loop: { runTurn, reset: loopReset, compact: loopCompact } as unknown as Loop,
    bus,
    wire,
    workspace: dir,
    approvalKind: () => undefined,
    model: "stub-llm",
    sessionPath: join(dir, "wire.jsonl"),
    history: [],
    approvalMemory: [],
    systemPrompt: "",
    todos: new TodoStore(),
  } satisfies Agent;

  const onExit = vi.fn();
  const coordinator = new TuiCoordinator({ tui: h.tui, editor, chat, agent, onExit });
  coordinator.start();
  await h.tui.start();
  return { coordinator, bus, runTurn, loopReset, loopCompact, wire, onExit, h, editor, chat, dir };
}

describe("TuiCoordinator", () => {
  let fixture: CoordinatorFixture;

  beforeEach(async () => {
    fixture = await setupCoordinator();
  });

  afterEach(() => {
    fixture.coordinator.stop();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("plain text becomes a user message and an engine turn", async () => {
    await fixture.coordinator.handleSubmit("帮我看看这个文件");
    await fixture.h.render();
    expect(fixture.h.viewport()).toContain("帮我看看这个文件");
    expect(fixture.runTurn).toHaveBeenCalledWith("帮我看看这个文件");
  });

  it("/clear resets the conversation without touching the engine turn", async () => {
    await fixture.coordinator.handleSubmit("第一句话");
    await fixture.h.render();
    expect(fixture.h.viewport()).toContain("第一句话");

    await fixture.coordinator.handleSubmit("/clear");
    await fixture.h.render();

    expect(fixture.h.viewport()).not.toContain("第一句话");
    expect(fixture.loopReset).toHaveBeenCalledOnce();
    expect(fixture.runTurn).toHaveBeenCalledTimes(1); // 只有第一句，/clear 不进引擎
  });

  it("/delete also removes the wire log", async () => {
    await fixture.wire.append({ type: "turn.started", turnId: 1, prompt: "x" });
    expect((await fixture.wire.readAll()).length).toBe(1);

    await fixture.coordinator.handleSubmit("/delete");

    expect(await fixture.wire.readAll()).toEqual([]);
    expect(fixture.loopReset).toHaveBeenCalledOnce();
  });

  it("/compact runs engine compaction without starting a turn", async () => {
    await fixture.coordinator.handleSubmit("/compact");
    expect(fixture.loopCompact).toHaveBeenCalledOnce();
    expect(fixture.runTurn).not.toHaveBeenCalled();
  });

  it("unknown slash command shows an error hint instead of a turn", async () => {
    await fixture.coordinator.handleSubmit("/nosuch");
    await fixture.h.render();
    expect(fixture.h.viewport()).toContain("unknown command: /nosuch");
    expect(fixture.runTurn).not.toHaveBeenCalled();
  });

  it("ignores submits while a turn is in flight, re-enables on turn.ended", async () => {
    let releaseTurn: () => void = () => {};
    fixture.runTurn.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTurn = resolve;
        }),
    );

    const first = fixture.coordinator.handleSubmit("第一条");
    await vi.waitFor(() => expect(fixture.runTurn).toHaveBeenCalledTimes(1));
    expect(fixture.editor.disableSubmit).toBe(true);

    await fixture.coordinator.handleSubmit("第二条（应被忽略）");
    expect(fixture.runTurn).toHaveBeenCalledTimes(1);

    releaseTurn();
    fixture.bus.emit("turn.ended", { turnId: 1, reason: "finish" });
    fixture.runTurn.mockResolvedValue(undefined);
    await first;
    await fixture.coordinator.handleSubmit("第三条");
    expect(fixture.runTurn).toHaveBeenCalledTimes(2);
    expect(fixture.editor.disableSubmit).toBe(false);
  });

  it("ignores slash commands while a turn is in flight", async () => {
    fixture.runTurn.mockImplementation(
      () =>
        new Promise<void>(() => {
          // 永不 resolve：turn 一直在飞
        }),
    );
    void fixture.coordinator.handleSubmit("跑个长任务");
    await vi.waitFor(() => expect(fixture.runTurn).toHaveBeenCalledTimes(1));

    await fixture.coordinator.handleSubmit("/clear");

    expect(fixture.loopReset).not.toHaveBeenCalled();
  });

  it("ignores submits while a slash command is executing", async () => {
    // busy 闸必须双向：/delete 的 wire.clear() 在飞时放行的 turn 会与 append 竞态
    let releaseSlash: () => void = () => {};
    const slowCommand = {
      name: "slow",
      description: "slow test command",
      execute: () =>
        new Promise<void>((resolve) => {
          releaseSlash = resolve;
        }),
    };
    const coordinator = new TuiCoordinator({
      tui: fixture.h.tui,
      editor: fixture.editor,
      chat: fixture.chat,
      agent: {
        bus: fixture.bus,
        loop: { runTurn: fixture.runTurn, reset: fixture.loopReset } as unknown as Loop,
        wire: fixture.wire,
      },
      commands: [slowCommand],
      onExit: fixture.onExit,
    });
    coordinator.start();

    const slash = coordinator.handleSubmit("/slow");
    await vi.waitFor(() => expect(fixture.editor.disableSubmit).toBe(true));

    await coordinator.handleSubmit("应被忽略的 turn");
    expect(fixture.runTurn).not.toHaveBeenCalled();

    releaseSlash();
    await slash;
    expect(fixture.editor.disableSubmit).toBe(false);

    coordinator.stop();
  });

  it("Ctrl+C triggers onExit", async () => {
    fixture.h.terminal.sendInput("\x03");
    await fixture.h.render();
    expect(fixture.onExit).toHaveBeenCalledOnce();
  });
});
