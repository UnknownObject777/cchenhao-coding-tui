import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinTools } from "../src/engine/tools/builtins.js";
import { ToolExecutor } from "../src/engine/tools/executor.js";

describe("builtin tools", () => {
  let dir: string;
  let executor: ToolExecutor;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tools-test-"));
    executor = new ToolExecutor();
    registerBuiltinTools(executor, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("write_file then read_file round-trips content inside the workspace", async () => {
    const write = await executor.execute("write_file", { path: "hello.txt", content: "hello world" });
    expect(write.ok).toBe(true);
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("hello world");

    const read = await executor.execute("read_file", { path: "hello.txt" });
    expect(read).toEqual({ ok: true, output: "hello world" });
  });

  it("refuses to write outside the workspace", async () => {
    const result = await executor.execute("write_file", { path: "../escape.txt", content: "x" });
    expect(result.ok).toBe(false);
  });

  it("run_command returns stdout", async () => {
    const result = await executor.execute("run_command", { command: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.output.trim()).toBe("hello");
  });

  it("run_command reports non-zero exit as an error result", async () => {
    const result = await executor.execute("run_command", { command: "exit 3" });
    expect(result.ok).toBe(false);
  });

  it("run_command kills the command on timeout", async () => {
    await executor.execute("write_file", { path: "sleeper.js", content: "setTimeout(() => {}, 10000)" });
    const result = await executor.execute("run_command", {
      command: "node sleeper.js",
      timeout_ms: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
  }, 5000);
});
