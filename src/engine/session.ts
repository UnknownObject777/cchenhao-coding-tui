/**
 * 会话存储（#30，#6 决策）：wire 日志按工作区分目录、按会话分文件。
 * 目录：<root>/<workspace-slug>/<session-id>.jsonl；root 默认 ~/.mini-agent/sessions。
 * print 模式的会话进 print/ 子目录，不参与「继续上次」（#6：print 是一次性任务）。
 */
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseWireRow } from "./wire.ts";

/**
 * 工作区路径 → 目录名片段：可读前缀 + 全路径短哈希（防 "my proj"/"my-proj"、
 * C:/x 与 D:/x 这类归一化碰撞共享会话目录）。
 */
export function workspaceSlug(workspace: string): string {
  const readable =
    workspace
      .replace(/^[a-zA-Z]:/, "")
      .replace(/[^a-zA-Z0-9-._]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "root";
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

export class SessionStore {
  private readonly dir: string;

  constructor(rootDir: string, workspace: string) {
    this.dir = join(rootDir, workspaceSlug(workspace));
  }

  static defaultRoot(): string {
    return join(homedir(), ".mini-agent", "sessions");
  }

  /** 新会话文件路径（时间戳 + 随机后缀保证唯一）。print 会话进子目录，latest() 看不到。 */
  createPath(kind: "chat" | "print" = "chat"): string {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    return kind === "print" ? join(this.dir, "print", `${id}.jsonl`) : join(this.dir, `${id}.jsonl`);
  }

  /** 最近一个 chat 会话文件（按 mtime），没有则 undefined。 */
  async latestPath(): Promise<string | undefined> {
    const sessions = await this.list();
    return sessions[0]?.path;
  }

  /** 全部 chat 会话（新→旧），带首轮 prompt 摘要（#47 会话选择器用）。 */
  async list(): Promise<SessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const files = names.filter((n) => n.endsWith(".jsonl"));
    const sessions: SessionInfo[] = [];
    for (const name of files) {
      const full = join(this.dir, name);
      const { mtimeMs } = await stat(full);
      sessions.push({ path: full, mtimeMs, summary: await readFirstPrompt(full) });
    }
    return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}

export interface SessionInfo {
  path: string;
  mtimeMs: number;
  /** 首个 turn.started 的 prompt（读不到则空串）。 */
  summary: string;
}

/** 只读文件头部找第一条 turn.started（会话可能很大，不全读）。 */
async function readFirstPrompt(path: string): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
      for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
        const row = parseWireRow(line);
        if (row?.event.type === "turn.started") {
          return row.event.prompt.slice(0, 60);
        }
      }
      return "";
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

