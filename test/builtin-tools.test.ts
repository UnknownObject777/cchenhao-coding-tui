import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

  it("run_command clamps cwd to the workspace root, not the session cwd (#75)", async () => {
    // 测试进程的 cwd 是仓库根，与临时工作区不同；命令打印出的必须是被钳制到工作区根后的 cwd
    const result = await executor.execute("run_command", { command: process.platform === "win32" ? "cd" : "pwd" });
    expect(result.ok).toBe(true);
    assertSameResolvedPath(result.output.trim(), dir);
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

  it("edit_file path escaping the workspace points the model to write_file (#56)", async () => {
    const result = await executor.execute("edit_file", {
      path: "../escape.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("escapes workspace");
    expect(result.output).toContain("write_file"); // 降级指引：改经工作区内路径用 write_file
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

  describe.runIf(dirSymlinkSupported())("run_command cwd through a symlinked workspace (#75)", () => {
    it("spawns in the realpath'd zone root, not the symlink path", async () => {
      const real = makeTempDir("tools-symlink-real-");
      const link = join(dirname(real), `tools-symlink-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
      try {
        symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
        const linkedExecutor = new ToolExecutor();
        registerBuiltinTools(linkedExecutor, link, new TodoStore());
        const result = await linkedExecutor.execute("run_command", {
          command: process.platform === "win32" ? "cd" : "pwd",
        });
        expect(result.ok).toBe(true);
        // 强制 CWD = canonical 区根（#74 区判定唯一入口的 realpath 根），与文件工具同一套根
        assertSameResolvedPath(result.output.trim(), real);
      } finally {
        rmSync(link, { recursive: true, force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });
  });
});

/** cmd 的 cd / sh 的 pwd 输出与期望路径解析后一致（Windows 上大小写不敏感比较）。 */
function assertSameResolvedPath(printed: string, expectedDir: string): void {
  const a = resolve(printed);
  const b = resolve(expectedDir);
  if (process.platform === "win32") {
    expect(a.toLowerCase()).toBe(b.toLowerCase());
  } else {
    expect(a).toBe(b);
  }
}

/** 目录级链接探测（win32 用免提权的 junction，POSIX 用 dir symlink）；失败整组跳过。 */
function dirSymlinkSupported(): boolean {
  try {
    const real = makeTempDir("tools-symlink-probe-real-");
    const link = join(dirname(real), `tools-symlink-probe-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      return true;
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}
