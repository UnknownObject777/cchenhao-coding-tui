import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TodoStore } from "../todo.ts";
import type { ToolExecutor } from "./executor.ts";
import { registerSearchTools } from "./search.ts";
import { registerTaskTools, TaskManager, DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS } from "./task.ts";
import { registerTodoTool } from "./todo.ts";
import { resolveInside as resolveInsideWorkspace } from "./workspace.ts";

/** 会话结束（进程退出）即回收后台任务：模块级单钩子，避免多次装配累积 exit 监听器。 */
const registeredManagers = new Set<TaskManager>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const manager of registeredManagers) manager.dispose();
  });
}

/** 内置玩具工具：read_file / write_file / edit_file / run_command / list_files / grep / glob / todo / task_status / task_stop。文件操作限制在工作区内；todo 与后台任务为会话内态。 */
export function registerBuiltinTools(
  executor: ToolExecutor,
  workspace: string,
  todos: TodoStore,
  options?: { sessionPath?: string; taskManager?: TaskManager },
): void {
  const root = resolve(workspace);

  const resolveInside = (path: string): string => resolveInsideWorkspace(root, path);

  // 后台任务（#61）：输出落盘到会话目录 tasks/；无 sessionPath 时落到系统临时目录（测试/独立装配可显式传入）
  const tasks =
    options?.taskManager ?? new TaskManager(join(dirname(options?.sessionPath ?? tmpdir()), "tasks"));
  registeredManagers.add(tasks);
  installExitHook();

  executor.register({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    approval: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace" } },
      required: ["path"],
    },
    execute: async (args) => readFile(resolveInside(String(args["path"])), "utf8"),
  });

  executor.register({
    name: "write_file",
    description: "Write a UTF-8 text file inside the workspace, creating parent directories.",
    approval: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const full = resolveInside(String(args["path"]));
      await writeFile(full, String(args["content"]), "utf8");
      return `wrote ${full}`;
    },
  });

  executor.register({
    name: "edit_file",
    description:
      "Replace old_string with new_string in an existing UTF-8 file. old_string must match exactly (character-for-character, including whitespace) and appear exactly once unless replace_all is set.",
    approval: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        old_string: { type: "string", description: "Exact text to find (must be unique)" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    execute: async (args) => {
      let full: string;
      try {
        full = resolveInside(String(args["path"]));
      } catch (error) {
        // #56：路径逃逸与「文件缺失」同款可行动错误——模型应改用工作区内的路径（可用 write_file 重写）
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: edit_file only edits files inside the workspace; ` +
            `use write_file with a workspace-relative path instead`,
        );
      }
      const oldText = String(args["old_string"]);
      const newText = String(args["new_string"]);
      if (oldText === "") {
        throw new Error("old_string must be a non-empty string");
      }
      let content: string;
      try {
        content = await readFile(full, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new Error(`file not found: ${full}; use write_file to create it`);
        }
        throw error;
      }
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        // 失败回退链（#56 决策）：精确匹配失败 → 可行动错误 → 模型重试 → 连续失败后由模型自行降级 write_file
        throw new Error(
          `String to replace not found in ${full}. edit_file requires an exact character-for-character match (including whitespace and indentation). ` +
            `Re-read the file and retry with a more precise old_string; if you keep failing, use write_file with the full new content instead.`,
        );
      }
      if (occurrences > 1 && args["replace_all"] !== true) {
        throw new Error(
          `old_string appears ${occurrences} times in ${full}; set replace_all=true to replace all, or include more surrounding context to make it unique.`,
        );
      }
      const next = occurrences === 1 ? content.replace(oldText, newText) : content.split(oldText).join(newText);
      await writeFile(full, next, "utf8");
      return `replaced ${occurrences} occurrence(s) in ${full}`;
    },
  });

  executor.register({
    name: "run_command",
    description:
      "Run a shell command in the workspace and return its combined output. Set background=true to start it as a background task: returns a task id immediately instead of waiting; poll with task_status and stop with task_stop.",
    approval: "command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: {
          type: "number",
          description: "Timeout in ms; default 30000 for foreground, 600000 for background",
        },
        background: { type: "boolean", description: "Start as a background task (default false)" },
      },
      required: ["command"],
    },
    execute: (args) => {
      const background = args["background"] === true;
      const timeout =
        typeof args["timeout_ms"] === "number" && Number.isFinite(args["timeout_ms"]) && args["timeout_ms"] > 0
          ? args["timeout_ms"]
          : background
            ? DEFAULT_BACKGROUND_TIMEOUT_MS
            : DEFAULT_COMMAND_TIMEOUT_MS;
      const command = String(args["command"]);
      if (background) return tasks.start(command, root, timeout);
      return runShell(command, root, timeout);
    },
  });

  registerSearchTools(executor, root);
  registerTaskTools(executor, tasks);
  registerTodoTool(executor, todos);
}

function runShell(command: string, cwd: string, timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const flags = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
    const child = spawn(shell, [...flags, command], { cwd, windowsHide: true });

    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child, () => reject(new Error(`command timed out after ${timeout}ms`)));
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = output.trim();
      if (code === 0) {
        resolvePromise(text || "(no output)");
      } else {
        reject(new Error(`command failed (exit ${String(code)}): ${text}`));
      }
    });
  });
}

/** Windows 上 child.kill 只杀 shell 本身，孙进程会残留；用 taskkill 杀整棵树。 */
function killTree(child: ReturnType<typeof spawn>, done: () => void): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => done());
  } else {
    child.kill("SIGKILL");
    done();
  }
}

/** 带 node 错误码(errno)的 Error 判别，用于 ENOENT 等分支。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
