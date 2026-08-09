import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TodoStore } from "../src/engine/todo.ts";
import { registerBuiltinTools } from "../src/engine/tools/builtins.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";

describe("builtin tools", () => {
  let dir: string;
  let executor: ToolExecutor;

  beforeEach(() => {
    dir = makeTempDir("tools-test-");
    executor = new ToolExecutor();
    registerBuiltinTools(executor, dir, new TodoStore());
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

  it("edit_file replaces a unique old_string", async () => {
    await executor.execute("write_file", { path: "a.ts", content: "const x = 1;\nconsole.log(x);\n" });
    const result = await executor.execute("edit_file", {
      path: "a.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const x = 2;\nconsole.log(x);\n");
  });

  it("edit_file rejects a missing old_string with an actionable error", async () => {
    await executor.execute("write_file", { path: "a.ts", content: "const x = 1;\n" });
    const result = await executor.execute("edit_file", {
      path: "a.ts",
      old_string: "const y = 2;",
      new_string: "const z = 3;",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
    expect(result.output).toContain("write_file"); // 降级指引
  });

  it("edit_file rejects a non-unique old_string unless replace_all is set", async () => {
    await executor.execute("write_file", { path: "a.ts", content: "x = 1;\nx = 1;\n" });
    const without = await executor.execute("edit_file", {
      path: "a.ts",
      old_string: "x = 1;",
      new_string: "y = 9;",
    });
    expect(without.ok).toBe(false);
    expect(without.output).toContain("2 times");
    expect(without.output).toContain("replace_all");
  });

  it("edit_file replaces every occurrence when replace_all is true", async () => {
    await executor.execute("write_file", { path: "a.ts", content: "x = 1;\nx = 1;\n" });
    const result = await executor.execute("edit_file", {
      path: "a.ts",
      old_string: "x = 1;",
      new_string: "y = 9;",
      replace_all: true,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("y = 9;\ny = 9;\n");
  });

  it("edit_file refuses to touch files outside the workspace", async () => {
    const result = await executor.execute("edit_file", {
      path: "../escape.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(result.ok).toBe(false);
  });

  it("edit_file rejects an empty old_string", async () => {
    await executor.execute("write_file", { path: "a.ts", content: "const x = 1;\n" });
    const result = await executor.execute("edit_file", { path: "a.ts", old_string: "", new_string: "b" });
    expect(result.ok).toBe(false);
  });

  it("edit_file on a missing file points the model to write_file", async () => {
    const result = await executor.execute("edit_file", {
      path: "nope.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("write_file");
  });

  it("edit_file is declared as a write-class approval tool", async () => {
    expect(executor.approvalKind("edit_file")).toBe("write");
  });
});
