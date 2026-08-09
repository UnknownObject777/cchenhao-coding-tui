/**
 * #62 diff 预览：极简 unified-ish diff（纯 Node、无依赖）+ 审批门携带 + 审批帧渲染。
 * 覆盖三层：createUnifiedDiff（纯函数）、computeWritePreview（读盘拼 diff）、
 * composed gate 集成（diff 随 approval.request 事件 + 应答源收到的 call 走）、审批帧渲染。
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createComposedGate } from "../src/engine/approval/composed-gate.ts";
import { EventBus, type EngineEvent } from "../src/engine/events.ts";
import { computeWritePreview, createUnifiedDiff } from "../src/engine/tools/diff.ts";
import type { ToolApprovalKind } from "../src/engine/tools/executor.ts";
import { ApprovalFrameComponent } from "../src/tui/components/messages/approval-frame.ts";
import { createTuiHarness } from "./helpers/tui-harness.ts";

describe("createUnifiedDiff", () => {
  it("returns undefined when nothing changed", () => {
    expect(createUnifiedDiff("a\nb\nc\n", "a\nb\nc\n")).toBeUndefined();
  });

  it("shows an added line as a + line inside a context hunk", () => {
    const diff = createUnifiedDiff("a\nb\nc\n", "a\nb\nx\nc\n");
    expect(diff).toContain("+x");
    expect(diff).not.toContain("-b"); // LCS 对齐 a/b/c，只有 x 是新增
    expect(diff).toContain("\n b\n"); // 上下文行仍以空格前缀
  });

  it("shows a removed line as a - line", () => {
    const diff = createUnifiedDiff("a\nb\nc\n", "a\nc\n");
    expect(diff).toContain("-b");
    expect(diff).not.toContain("+b");
  });

  it("shows a modified line as - old + new pairs", () => {
    const diff = createUnifiedDiff("line1\nline2\nline3\n", "line1\nline2 changed\nline3\n");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+line2 changed");
  });

  it("emits unified-ish hunk headers with counts", () => {
    const diff = createUnifiedDiff("line1\nline2\nline3\n", "line1\nline2 changed\nline3\n");
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("splits far-apart changes into separate hunks", () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    const newLines = Array.from({ length: 40 }, (_, i) => (i === 0 || i === 39 ? `${i + 1} modified` : `line${i + 1}`));
    const diff = createUnifiedDiff(oldText, newLines.join("\n") + "\n");
    const hunkCount = (diff ?? "").split("\n").filter((l) => l.startsWith("@@")).length;
    expect(hunkCount).toBe(2);
  });

  it("prefixes file headers when a label is given", () => {
    const diff = createUnifiedDiff("a\n", "a\nb\n", "src/x.ts");
    expect(diff).toContain("--- a/src/x.ts");
    expect(diff).toContain("+++ b/src/x.ts");
  });

  it("normalizes CRLF so line endings do not count as changes", () => {
    expect(createUnifiedDiff("a\r\nb\r\n", "a\r\nb\r\nc\r\n")).not.toBeUndefined();
    expect(createUnifiedDiff("a\r\nb\r\n", "a\nb\n")).toBeUndefined();
  });

  it("bails out (undefined) when the input is too large to diff", () => {
    const big = Array.from({ length: 600 }, (_, i) => `line${i}`).join("\n") + "\n";
    expect(createUnifiedDiff(big, big + "tail\n")).toBeUndefined();
  });
});

describe("computeWritePreview", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("diff-preview-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a diff for write_file onto an existing file", async () => {
    writeFileSync(join(dir, "a.ts"), "line1\nline2\nline3\n", "utf8");
    const diff = await computeWritePreview(
      { id: "1", name: "write_file", args: { path: "a.ts", content: "line1\nline2 changed\nline3\n" } },
      dir,
    );
    expect(diff).toBeDefined();
    expect(diff).toContain("--- a/a.ts");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+line2 changed");
  });

  it("returns undefined for a new file (no old content to compare)", async () => {
    const diff = await computeWritePreview(
      { id: "1", name: "write_file", args: { path: "new.txt", content: "x\n" } },
      dir,
    );
    expect(diff).toBeUndefined();
  });

  it("returns undefined when content or path is missing", async () => {
    writeFileSync(join(dir, "a.ts"), "a\n", "utf8");
    expect(
      await computeWritePreview({ id: "1", name: "write_file", args: { path: "a.ts" } }, dir),
    ).toBeUndefined();
    expect(
      await computeWritePreview({ id: "1", name: "write_file", args: {} }, dir),
    ).toBeUndefined();
  });

  it("returns undefined for a path escaping the workspace instead of throwing", async () => {
    expect(
      await computeWritePreview(
        { id: "1", name: "write_file", args: { path: "../outside.txt", content: "x\n" } },
        dir,
      ),
    ).toBeUndefined();
  });

  it("projects the edit_file replacement as a diff", async () => {
    writeFileSync(join(dir, "b.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const diff = await computeWritePreview(
      { id: "1", name: "edit_file", args: { path: "b.ts", old_string: "const b = 2;", new_string: "const b = 3;" } },
      dir,
    );
    expect(diff).toBeDefined();
    expect(diff).toContain("-const b = 2;");
    expect(diff).toContain("+const b = 3;");
    // 预览不落盘
    expect(await import("node:fs/promises").then((f) => f.readFile(join(dir, "b.ts"), "utf8"))).toBe(
      "const a = 1;\nconst b = 2;\n",
    );
  });

  it("respects replace_all in the edit_file preview", async () => {
    writeFileSync(join(dir, "c.ts"), "x\nx\n", "utf8");
    const diff = await computeWritePreview(
      { id: "1", name: "edit_file", args: { path: "c.ts", old_string: "x", new_string: "y", replace_all: true } },
      dir,
    );
    const added = (diff ?? "").split("\n").filter((l) => l.startsWith("+y")).length;
    expect(added).toBe(2);
  });

  it("returns undefined when edit_file would not match", async () => {
    writeFileSync(join(dir, "d.ts"), "hello\n", "utf8");
    expect(
      await computeWritePreview(
        { id: "1", name: "edit_file", args: { path: "d.ts", old_string: "nope", new_string: "x" } },
        dir,
      ),
    ).toBeUndefined();
  });

  it("ignores non-write tools", async () => {
    expect(
      await computeWritePreview({ id: "1", name: "run_command", args: { command: "npm test" } }, dir),
    ).toBeUndefined();
  });
});

describe("composed gate carries the write diff (#62)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("gate-diff-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(answer: "allow" | "always" | "deny" = "allow") {
    const bus = new EventBus();
    const events: EngineEvent[] = [];
    bus.on("approval.request", (p) => events.push({ type: "approval.request", ...p }));
    const ask = vi.fn<(call: { diff?: string }) => Promise<"allow" | "always" | "deny">>().mockResolvedValue(answer);
    const kinds: Record<string, ToolApprovalKind> = {
      read_file: "read",
      write_file: "write",
      edit_file: "write",
      run_command: "command",
    };
    const gate = createComposedGate({
      bus,
      workspace: dir,
      answerer: { ask },
      approvalKind: (name: string): ToolApprovalKind | undefined => kinds[name],
    });
    return { bus, events, ask, gate };
  }

  it("attaches the diff to the approval.request event and the call handed to the answerer", async () => {
    writeFileSync(join(dir, "a.ts"), "line1\nline2\n", "utf8");
    const { gate, events, ask } = setup("allow");
    const decision = await gate.request({
      id: "1",
      name: "write_file",
      args: { path: "a.ts", content: "line1\nline2 changed\n" },
    });
    expect(decision).toBe("allow");
    const event = events.find((e): e is Extract<EngineEvent, { type: "approval.request" }> => e.type === "approval.request");
    expect(event).toBeDefined();
    expect(event!.diff).toBeDefined();
    expect(event!.diff).toContain("+line2 changed");
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ diff: expect.any(String) }));
  });

  it("leaves non-write confirm calls without a diff", async () => {
    const { gate, events, ask } = setup("allow");
    await gate.request({ id: "2", name: "run_command", args: { command: "npm install" } });
    const event = events.find((e): e is Extract<EngineEvent, { type: "approval.request" }> => e.type === "approval.request");
    expect(event!.diff).toBeUndefined();
    expect(ask.mock.calls[0]![0]).not.toHaveProperty("diff");
  });

  it("skips the diff for auto-allowed or auto-denied calls", async () => {
    const { gate, events, ask } = setup("allow");
    await gate.request({ id: "3", name: "read_file", args: { path: "a.ts" } });
    await gate.request({ id: "4", name: "run_command", args: { command: "rm -rf /" } });
    expect(ask).not.toHaveBeenCalled();
    expect(events.every((e) => e.type !== "approval.request" || e.diff === undefined)).toBe(true);
  });
});

describe("approval frame renders the diff preview", () => {
  it("shows added/removed lines and keeps the key hints", async () => {
    const h = createTuiHarness(80, 24);
    const frame = new ApprovalFrameComponent({
      id: "1",
      name: "write_file",
      args: { path: "a.ts" },
      diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n line1\n-line2\n+line2 changed\n line3",
    });
    h.tui.addChild(frame);
    await h.tui.start();
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("+line2 changed");
    expect(vp).toContain("-line2");
    expect(vp).toContain("write_file");
    expect(vp).toContain("[y]");
    h.stop();
  });

  it("caps the diff preview and notes the omitted tail", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => (i === 30 ? `-old${i}` : `line${i}`));
    const diff = lines.join("\n") + "\n";
    const h = createTuiHarness(80, 40);
    const frame = new ApprovalFrameComponent({
      id: "1",
      name: "write_file",
      args: { path: "big.ts" },
      diff,
    });
    h.tui.addChild(frame);
    await h.tui.start();
    await h.render();
    const vp = h.viewport();
    expect(vp).toContain("省略");
    h.stop();
  });
});
