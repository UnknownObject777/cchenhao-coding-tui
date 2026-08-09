/**
 * 后台任务管理（#61）：run_command background=true 启动的会话内任务。
 * 契约：启动即返 task id（不自带新事件，状态由模型经 task_status / task_stop 拉取）；
 * 输出 append 落盘到会话目录 tasks/<id>.log + 内存累计；会话结束（进程退出）即回收。
 * 范围外（#51 玩具约束）：跨会话持久化、交互式 stdin/pty、调度（仅并行上限）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutor } from "./executor.ts";

/** 同步 run_command 默认超时（现状 #61 前行为，保持不变）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** 后台任务默认超时：覆盖 npm test / 构建这类长命令（自举验收场景）。 */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 600_000;
/** 并行后台任务上限：超过拒绝启动（防滥用；上限之外的调度不做）。 */
export const MAX_BACKGROUND_TASKS = 8;

export type TaskStatus = "running" | "done" | "failed" | "stopped";

export interface BackgroundTaskInfo {
  id: string;
  status: TaskStatus;
  /** 结束时的退出码；running / stopped / 超时 / spawn 失败为 null。 */
  exitCode: number | null;
  /** 累计输出（stdout+stderr 合并，与落盘内容一致）。 */
  output: string;
  logPath: string;
}

interface BackgroundTask extends BackgroundTaskInfo {
  command: string;
  /** 任务结束标志：stop / timeout / close / error 首个生效者定终态，后续事件不覆盖。 */
  settled: boolean;
  child: ChildProcess;
}

/** 从 run_command 启动文本里取 task id（`task task-1 started`）。 */
export function taskIdFrom(result: string): string | undefined {
  return result.match(/task (task-\d+) started/)?.[1];
}

export class TaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private nextId = 1;
  private readonly logDir: string;
  private readonly maxTasks: number;

  constructor(logDir: string, maxTasks = MAX_BACKGROUND_TASKS) {
    // erasableSyntaxOnly：不用 constructor parameter properties，显式赋值
    this.logDir = logDir;
    this.maxTasks = maxTasks;
    // 落盘目录确保存在（createWriteStream 不建父目录）
    mkdirSync(logDir, { recursive: true });
  }

  /** 启动后台命令；超过并行上限抛可行动错误。返回提示文本（含 task id 与落盘路径）。 */
  start(command: string, cwd: string, timeoutMs: number): string {
    const running = [...this.tasks.values()].filter((t) => t.status === "running").length;
    if (running >= this.maxTasks) {
      throw new Error(
        `too many background tasks running (max ${this.maxTasks}); wait for one to finish or stop it first`,
      );
    }

    const id = `task-${this.nextId}`;
    this.nextId += 1;
    const logPath = join(this.logDir, `${id}.log`);

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const flags = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
    const child = spawn(shell, [...flags, command], { cwd, windowsHide: true });
    const task: BackgroundTask = {
      id,
      command,
      status: "running",
      exitCode: null,
      output: "",
      logPath,
      settled: false,
      child,
    };
    this.tasks.set(id, task);

    // 落盘失败不致命（玩具）：写流错误静默，不阻断任务本身
    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.on("error", () => {});

    const timer = setTimeout(() => {
      if (task.settled) return;
      task.settled = true;
      task.status = "failed";
      const note = `\ncommand timed out after ${timeoutMs}ms\n`;
      task.output += note;
      killTreeSync(child); // 同步杀：保证返回时进程树已死（写流/目录句柄可释放）
      logStream.write(note);
      logStream.end();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      task.output += chunk.toString();
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      task.output += chunk.toString();
      logStream.write(chunk);
    });
    child.on("error", (error) => {
      if (task.settled) return;
      task.settled = true;
      clearTimeout(timer);
      task.status = "failed";
      task.output += `spawn error: ${error.message}\n`;
      logStream.end();
    });
    child.on("close", (code) => {
      if (task.settled) return;
      task.settled = true;
      clearTimeout(timer);
      task.exitCode = code;
      task.status = code === 0 ? "done" : "failed";
      logStream.end();
    });

    return `task ${id} started in background (timeout ${timeoutMs}ms); log: ${logPath}`;
  }

  /** 任务当前状态快照；未知 id 抛可行动错误。 */
  status(id: string): BackgroundTaskInfo {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new Error(`unknown task: ${id}; background tasks do not survive session restart`);
    }
    return { id: task.id, status: task.status, exitCode: task.exitCode, output: task.output, logPath: task.logPath };
  }

  /** 停止运行中的任务（kill 整棵进程树）；未知/已结束 id 抛可行动错误。 */
  stop(id: string): string {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`unknown task: ${id}`);
    if (task.status !== "running") throw new Error(`task ${id} already ${task.status}`);
    task.settled = true;
    task.status = "stopped";
    killTreeSync(task.child);
    return `stopped ${id}`;
  }

  /** 会话结束回收（进程退出钩子调用）：同步尽力 kill 全部运行中任务。 */
  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") killTreeSync(task.child);
    }
  }
}

/** Windows 上 child.kill 只杀 shell 本身，孙进程会残留；taskkill 杀整棵树。统一同步版（stop/超时/dispose 都要求返回时进程已死）。 */
function killTreeSync(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

/** task_status 的文本化快照：状态 + 退出码 + 落盘路径 + 累计输出（整体过 executor 护栏截断）。 */
function formatStatus(info: BackgroundTaskInfo): string {
  const lines = [`status: ${info.status}`];
  if (info.exitCode !== null) lines.push(`exit_code: ${info.exitCode}`);
  lines.push(`log: ${info.logPath}`);
  lines.push("--- output ---", info.output);
  return lines.join("\n");
}

/** 后台任务查看/停止工具（#61）。task_status 只读 → read 类自动放行；
 * task_stop 不声明分类 → 默认 confirm（安全缺省；能停的只有本会话启动的任务）。 */
export function registerTaskTools(executor: ToolExecutor, tasks: TaskManager): void {
  executor.register({
    name: "task_status",
    description:
      "Check a background task started by run_command with background=true. Returns status (running/done/failed/stopped), exit code, and accumulated output so far.",
    approval: "read",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id from the run_command background response" } },
      required: ["id"],
    },
    execute: (args) => formatStatus(tasks.status(String(args["id"]))),
  });

  executor.register({
    name: "task_stop",
    description: "Stop a running background task (kills its whole process tree).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id from the run_command background response" } },
      required: ["id"],
    },
    execute: (args) => tasks.stop(String(args["id"])),
  });
}
