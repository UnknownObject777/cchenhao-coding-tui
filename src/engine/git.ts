/**
 * #62 git 感知：只读探测工作区 git 脏状态（会话开始一次），不做任何 git 写操作。
 * 非 git 仓库 / git 不可用 / 超时一律静默返回 undefined——探测只是提醒，绝不能拖住或炸掉会话。
 */
import { execFile } from "node:child_process";

export interface GitDirtyState {
  /** `git status --porcelain` 的非空行数（含已修改、已暂存、未跟踪文件）。 */
  count: number;
}

/** 探测超时：git 卡死（如大仓/锁文件）时 2s 放弃，按「无脏状态」处理。 */
const GIT_PROBE_TIMEOUT_MS = 2_000;

export function detectGitDirty(workspace: string): Promise<GitDirtyState | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd: workspace, timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const count = stdout.split("\n").filter((line) => line.trim() !== "").length;
        resolve(count === 0 ? undefined : { count });
      },
    );
  });
}
