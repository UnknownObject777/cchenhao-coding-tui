import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ToolExecutor } from "./executor.js";

/** 内置玩具工具：read_file / write_file / run_command。文件操作限制在工作区内。 */
export function registerBuiltinTools(executor: ToolExecutor, workspace: string): void {
  const root = resolve(workspace);

  const resolveInside = (path: string): string => {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`path escapes workspace: ${path}`);
    }
    return full;
  };

  executor.register({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
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
    name: "run_command",
    description: "Run a shell command in the workspace and return its combined output.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "Optional timeout, default 30000" },
      },
      required: ["command"],
    },
    execute: (args) => {
      const timeout = typeof args["timeout_ms"] === "number" ? args["timeout_ms"] : 30_000;
      return runShell(String(args["command"]), root, timeout);
    },
  });
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
