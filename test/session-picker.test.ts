import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { SessionStore } from "../src/engine/session.ts";
import { WireService } from "../src/engine/wire.ts";
import { pickSession } from "../src/tui/session-picker.ts";
import { createTuiHarness } from "./helpers/tui-harness.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

describe("session picker (#47)", () => {
  let dir: string;
  let store: SessionStore;
  let paths: string[];

  beforeEach(async () => {
    dir = makeTempDir("picker-test-");
    store = new SessionStore(dir, "D:/proj");
    paths = [];
    // 两个会话，摘要分别是 甲/乙
    for (const prompt of ["会话甲", "会话乙"]) {
      const path = store.createPath();
      await new WireService(path).append({ type: "turn.started", turnId: 1, prompt });
      paths.push(path);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists sessions with summaries, newest first", async () => {
    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.summary).sort()).toEqual(["会话乙", "会话甲"]);
  });

  it("digit key resumes the chosen session", async () => {
    const sessions = await store.list();
    const h = createTuiHarness(80, 24);
    await h.tui.start();

    const choicePromise = pickSession(h.tui, sessions);
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("选择会话");
    expect(vp).toContain("[1]");

    h.terminal.sendInput("2");
    const choice = await choicePromise;
    expect(choice).toEqual({ kind: "resume", path: sessions[1]!.path });
    h.stop();
  });

  it("n starts a new session; enter resumes the latest", async () => {
    const sessions = await store.list();
    const h = createTuiHarness(80, 24);
    await h.tui.start();

    let promise = pickSession(h.tui, sessions);
    h.terminal.sendInput("n");
    expect(await promise).toEqual({ kind: "new" });

    promise = pickSession(h.tui, sessions);
    h.terminal.sendInput("\r");
    expect(await promise).toEqual({ kind: "resume", path: sessions[0]!.path });
    h.stop();
  });

  it("bootstrap resumes the picked session's history", async () => {
    const sessions = await store.list();
    const picked = sessions.find((s) => s.summary === "会话甲")!;
    const agent = await bootstrap({
      workspace: "D:/proj",
      fake: true,
      session: { resume: picked.path },
      sessionRoot: dir,
    });
    expect(agent.sessionPath).toBe(picked.path);
    expect(agent.history[0]).toEqual({ role: "user", text: "会话甲" });
  });
});
