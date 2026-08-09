import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCall } from "../src/engine/approval/rules.ts";
import { TodoStore } from "../src/engine/todo.ts";
import { registerBuiltinTools } from "../src/engine/tools/builtins.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  TaskManager,
  taskIdFrom,
} from "../src/engine/tools/task.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

/** 从 run_command 的返回里取出 task id（`task task-1 started ...`）；复用实现的解析函数。 */
function taskIdOf(output: string): string {
  const id = taskIdFrom(output);
  if (id === undefined) throw new Error(`no task id in output: ${output}`);
  return id;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询 task_status 直到输出匹配 re（或超时抛错）。 */
async function waitStatus(executor: ToolExecutor, id: string, re: RegExp, timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const result = await executor.execute("task_status", { id });
    expect(result.ok).toBe(true);
    if (re.test(result.output)) return result.output;
    if (Date.now() - start > timeoutMs) throw new Error(`task ${id} did not match ${re} in time: ${result.output}`);
    await sleep(25);
  }
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`file never appeared: ${path}`);
    await sleep(20);
  }
}

describe("background tasks", () => {
  let dir: string;
  let executor: ToolExecutor;
  let manager: TaskManager;

  beforeEach(async () => {
    dir = makeTempDir("bg-task-");
    executor = new ToolExecutor();
    manager = new TaskManager(join(dir, "tasks"), 4);
    registerBuiltinTools(executor, dir, new TodoStore(), {
      sessionPath: join(dir, "sess.jsonl"),
      taskManager: manager,
    });
    // Windows cmd /d /s /c 会破坏内嵌双引号（既有 runShell 限制），
    // 命令一律用脚本文件承载，与 builtin-tools.test.ts 同风格
    await executor.execute("write_file", { path: "sleep.js", content: "setTimeout(() => {}, 10000)\n" });
    await executor.execute("write_file", {
      path: "marker.js",
      content: "require('fs').writeFileSync('marker', 'x'); setTimeout(() => {}, 4000)\n",
    });
    await executor.execute("write_file", {
      path: "stop-marker.js",
      content: "require('fs').writeFileSync('stop-marker', 'x'); setTimeout(() => { console.log('should-not-appear') }, 10000)\n",
    });
    await executor.execute("write_file", { path: "out.js", content: "console.log('bg-done')\n" });
    await executor.execute("write_file", { path: "persist.js", content: "console.log('persist-me')\n" });
  });

  afterEach(() => {
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("run_command background=true returns immediately with a task id", async () => {
    const result = await executor.execute("run_command", {
      command: "node sleep.js",
      background: true,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/task task-\d+ started/);
    expect(result.output).toContain("tasks"); // 落盘位置提示
  });

  it("reports done with output via task_status", async () => {
    const startResult = await executor.execute("run_command", {
      command: "node out.js",
      background: true,
    });
    const id = taskIdOf(startResult.output);
    const out = await waitStatus(executor, id, /status: done/);
    expect(out).toContain("exit_code: 0");
    expect(out).toContain("bg-done");
  });

  it("reports running while the command is still executing", async () => {
    const startResult = await executor.execute("run_command", {
      command: "node marker.js",
      background: true,
    });
    const id = taskIdOf(startResult.output);
    await waitForFile(join(dir, "marker"));
    const out = await executor.execute("task_status", { id });
    expect(out.ok).toBe(true);
    expect(out.output).toContain("status: running");
  });

  it("task_status on an unknown id gives an actionable error", async () => {
    const result = await executor.execute("task_status", { id: "task-99" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unknown task");
  });

  it("task_stop stops a running task and freezes its output", async () => {
    const startResult = await executor.execute("run_command", {
      command: "node stop-marker.js",
      background: true,
    });
    const id = taskIdOf(startResult.output);
    await waitForFile(join(dir, "stop-marker"));

    const stop = await executor.execute("task_stop", { id });
    expect(stop.ok).toBe(true);

    const out = await executor.execute("task_status", { id });
    expect(out.ok).toBe(true);
    expect(out.output).toContain("status: stopped");

    await sleep(300); // 停止后不应再产出
    const after = await executor.execute("task_status", { id });
    expect(after.output).not.toContain("should-not-appear");
  });

  it("task_stop on an ended task is an error", async () => {
    const startResult = await executor.execute("run_command", {
      command: "echo quick",
      background: true,
    });
    const id = taskIdOf(startResult.output);
    await waitStatus(executor, id, /status: done/);

    const stop = await executor.execute("task_stop", { id });
    expect(stop.ok).toBe(false);
    expect(stop.output).toContain("already");
  });

  it("background task times out and reports failed", async () => {
    const startResult = await executor.execute("run_command", {
      command: "node sleep.js",
      background: true,
      timeout_ms: 300,
    });
    const id = taskIdOf(startResult.output);
    const out = await waitStatus(executor, id, /status: failed/);
    expect(out).toContain("timed out");
  }, 10000);

  it("persists task output under the session directory", async () => {
    const startResult = await executor.execute("run_command", {
      command: "node persist.js",
      background: true,
    });
    const id = taskIdOf(startResult.output);
    await waitStatus(executor, id, /status: done/);

    const logPath = join(dir, "tasks", `${id}.log`);
    expect(existsSync(logPath)).toBe(true);
    const text = await readFile(logPath, "utf8");
    expect(text).toContain("persist-me");
  });

  it("parallel task limit rejects additional tasks", async () => {
    const small = new TaskManager(join(dir, "tasks-small"), 2);
    const ex2 = new ToolExecutor();
    registerBuiltinTools(ex2, dir, new TodoStore(), {
      sessionPath: join(dir, "s2.jsonl"),
      taskManager: small,
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const ok = await ex2.execute("run_command", {
          command: "node sleep.js",
          background: true,
        });
        expect(ok.ok).toBe(true);
      }
      const third = await ex2.execute("run_command", {
        command: "node sleep.js",
        background: true,
      });
      expect(third.ok).toBe(false);
      expect(third.output).toContain("max 2");
    } finally {
      small.dispose();
    }
  });

  it("declares approval kinds: task_status read, task_stop unclassified", () => {
    expect(executor.approvalKind("task_status")).toBe("read");
    expect(executor.approvalKind("task_stop")).toBeUndefined();
  });

  it("background=true does not bypass command approval patterns", () => {
    const ws = "D:/p";
    expect(classifyCall({ id: "1", name: "run_command", args: { command: "rm -rf node_modules", background: true } }, ws, "command")).toBe("deny");
    expect(classifyCall({ id: "1", name: "run_command", args: { command: "git push", background: true } }, ws, "command")).toBe("deny");
    expect(classifyCall({ id: "1", name: "run_command", args: { command: "npm test", background: true } }, ws, "command")).toBe("allow");
  });

  it("exports default timeouts: 30s sync, 600s background", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_BACKGROUND_TIMEOUT_MS).toBe(600_000);
  });

  it("ignores a non-positive timeout_ms and falls back to the default", async () => {
    const result = await executor.execute("run_command", { command: "echo ok", timeout_ms: 0 });
    expect(result.ok).toBe(true);
    expect(result.output.trim()).toBe("ok");
  });
});
