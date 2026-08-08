/**
 * 会话存储（#30，#6 决策）：wire 日志按工作区分目录、按会话分文件。
 * 目录：<root>/<workspace-slug>/<session-id>.jsonl；root 默认 ~/.mini-agent/sessions。
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 工作区路径 → 目录名片段（保可读性，只留字母数字与 -._）。 */
export function workspaceSlug(workspace: string): string {
  return workspace.replace(/^[a-zA-Z]:/, "").replace(/[^a-zA-Z0-9-._]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

export class SessionStore {
  private readonly dir: string;

  constructor(rootDir: string, workspace: string) {
    this.dir = join(rootDir, workspaceSlug(workspace));
  }

  static defaultRoot(): string {
    return join(homedir(), ".mini-agent", "sessions");
  }

  /** 新会话文件路径（时间戳 + 随机后缀保证唯一）。 */
  create(): string {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    return join(this.dir, `${id}.jsonl`);
  }

  /** 最近一个会话文件（按 mtime），没有则 undefined。 */
  async latest(): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return undefined;
    }
    const files = names.filter((n) => n.endsWith(".jsonl"));
    if (files.length === 0) return undefined;

    let newest: string | undefined;
    let newestMtime = -1;
    for (const name of files) {
      const full = join(this.dir, name);
      const { mtimeMs } = await stat(full);
      if (mtimeMs > newestMtime) {
        newestMtime = mtimeMs;
        newest = full;
      }
    }
    return newest;
  }
}
