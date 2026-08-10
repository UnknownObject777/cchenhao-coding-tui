/**
 * #86 worktree 创建与分支绑定：自进化会话启动时在 worktrees/<slug> 创建独立 worktree + 独立分支，
 * 会话全程绑定该根（bootstrap 把 workspace / zone 根切到 worktree 根）。
 *
 * 关键决策（来自 #68 调研与 #71 resolution）：
 * - 命名 worktrees/<slug>、分支 cage-<slug>；注册表 = `git worktree list --porcelain`，不另存状态。
 * - 规避并发 git 锁（claude-code #55724 实证）：进程内互斥串行化创建；同路径已注册 → 幂等复用（双重检查）。
 * - baseRef 用当前 HEAD（本地玩具仓库常无 remote，origin/HEAD 不可用）；未提交改动留在主工作树，互不干扰。
 * - 回收（拆除 / TTL 收割 / 未提交改动保护）属 #88，不在本票范围。
 */
import { execFile } from "node:child_process";
import { join, relative, sep } from "node:path";
import { canonicalZoneRoot } from "./zone.ts";

export interface WorktreeInfo {
  /** worktree 根（canonical realpath，与 #74 区判定同一形态；Windows junction/大小写已归一）。 */
  root: string;
  /** 独立分支名（cage-<slug>）。 */
  branch: string;
  /** 相对主仓库根的目录（worktrees/<slug>，正斜杠）。 */
  relativePath: string;
}

/** worktree 目录名与分支前缀（#68 调研：worktrees/<slug>、分支 cage-<slug>）。 */
const WORKTREES_DIR = "worktrees";
const BRANCH_PREFIX = "cage-";

/** git 子进程超时：卡死（大仓/锁）时 30s 放弃并报错——创建是会话启动的硬依赖，不能无限等。 */
const GIT_TIMEOUT_MS = 30_000;

/** 进程内创建互斥：并发 ensureWorktree 串行化，规避 git worktree 管理锁竞争（#86）。 */
let createQueue: Promise<void> = Promise.resolve();
function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = createQueue.then(fn, fn);
  createQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 会话 slug（时间戳 + 随机后缀，全局唯一；目录与分支名安全字符）。 */
export function worktreeSlug(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 在主仓库根下创建（或幂等复用）worktree。串行化 + 双重检查：
 * 同 slug 并发进入时，先到的完成创建，后到的在锁内看到已注册 → 直接复用，不碰 git 锁。
 * 非 git 仓库 / git 不可用 / 超时一律大声报错（用户显式要求自进化会话，静默会误导）。
 */
export async function ensureWorktree(workspace: string, slug: string): Promise<WorktreeInfo> {
  const mainRoot = canonicalZoneRoot(workspace);
  const relativePath = `${WORKTREES_DIR}/${slug}`;
  const target = joinWorktreeRoot(mainRoot, slug);
  const branch = `${BRANCH_PREFIX}${slug}`;
  return withCreateLock(async () => {
    const existing = await findWorktree(mainRoot, target);
    if (existing !== undefined) return existing;
    // -b <branch>：独立分支（#68：一个分支同一时刻只能被一棵 worktree 检出）；baseRef 缺省 = HEAD
    await runGit(mainRoot, ["worktree", "add", "-b", branch, relativePath]);
    return { root: canonicalZoneRoot(target), branch, relativePath };
  });
}

/** 注册表解析：`git worktree list --porcelain`，含主工作树；每棵 worktree 一个条目。 */
export async function listWorktrees(workspace: string): Promise<WorktreeInfo[]> {
  const mainRoot = canonicalZoneRoot(workspace);
  const stdout = await runGit(mainRoot, ["worktree", "list", "--porcelain"]);
  const infos: WorktreeInfo[] = [];
  let root: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (root !== undefined) infos.push(toInfo(mainRoot, root, branch));
    root = undefined;
    branch = undefined;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) root = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
  }
  flush();
  return infos;
}

/** 按 canonical 根查找已注册 worktree（Windows 大小写不敏感，与 zone.ts 同一纪律）。 */
async function findWorktree(mainRoot: string, target: string): Promise<WorktreeInfo | undefined> {
  const targetCanonical = canonicalZoneRoot(target);
  const fold = process.platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;
  for (const info of await listWorktrees(mainRoot)) {
    if (fold(info.root) === fold(targetCanonical)) return info;
  }
  return undefined;
}

function toInfo(mainRoot: string, rawRoot: string, branch: string | undefined): WorktreeInfo {
  const root = canonicalZoneRoot(rawRoot);
  return { root, branch: branch ?? "", relativePath: relative(mainRoot, root).split(sep).join("/") };
}

function joinWorktreeRoot(mainRoot: string, slug: string): string {
  // 与传入 git 的相对路径保持同一目录（worktrees/<slug>）；canonicalZoneRoot 会把分隔符/大小写归一，匹配无碍
  return join(mainRoot, WORKTREES_DIR, slug);
}

/** 跑 git 只读/创建命令；失败带 git stderr 细节抛错。 */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = String(stderr).trim();
        reject(new Error(`git ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}
