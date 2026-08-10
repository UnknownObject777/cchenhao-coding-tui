/**
 * 路径区判定（#74）：唯一的路径区入口。
 * 任何工具的文件路径先经 realpath 解析（symlink、Windows 大小写、gitdir 指针）再判定
 * 「区内（区根内）/ 区外 / 保护段（.git 等，无条件 deny）」，审批规则与所有写工具统一调用本模块。
 *
 * 关键决策（来自 issue #71 resolution 与 docs/research/agent-sandbox-worktree.md）：
 * - realpath 解析走「最深已存在祖先 + 字面后缀」：写目标常是尚不存在的文件，realpath 整串会失败，
 *   但对已存在部分（含 symlink、Windows 实际大小写、junction）仍解析到真实路径。
 * - 末尾悬空 symlink（目标不存在）realpath 解析不到，但写操作会穿到链接目标——按链接目标重判区。
 * - worktree 里 `.git` 是指针文件（`gitdir: <主仓库 git 目录>`），词法上在区内、realpath 也解析不到
 *   指针内容——按段名命中 `.git` 无条件 deny，且指针指向的真实 git 目录同样保护。
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathZone = "inside" | "outside" | "protected";

/** 保护路径段（#63/#74）：区内的 git 元数据一律不可写；段名大小写不敏感（Windows FS）。 */
const PROTECTED_PATH_SEGMENTS = [".git"];

/** gitdir 指针文件首行前缀（git worktree / submodule 的 `.git` 文件）。 */
const GITDIR_PREFIX = "gitdir:";

/** Windows 文件系统大小写不敏感（含 NTFS 与 junction 的对等关系），比较时统一折叠。 */
const IS_CASE_INSENSITIVE = process.platform === "win32";

function fold(path: string): string {
  return IS_CASE_INSENSITIVE ? path.toLowerCase() : path;
}

/** target 是否位于 root 之下（含 root 自身）。折叠大小写后做前缀比较。 */
function pathHasPrefix(root: string, target: string): boolean {
  const a = fold(root);
  const b = fold(target);
  if (b === a) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * realpath 最深已存在祖先 + 剩余字面后缀；全部不存在（如测试里的虚构路径）时退回词法 resolve。
 * 使「写目标尚不存在」与「symlink/大小写」两类输入都能拿到规范路径。
 */
function realpathDeep(input: string): string {
  const abs = resolve(input);
  try {
    return realpathSync(abs);
  } catch {
    // 目标本身不存在：向上找最深已存在祖先
  }
  let current = abs;
  const suffix: string[] = [];
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return abs; // 到文件系统根仍不存在：词法兜底
    suffix.unshift(basename(current));
    current = parent;
    try {
      return join(realpathSync(current), ...suffix);
    } catch {
      // 继续向上
    }
  }
}

/** `.git` 指针文件（gitdir: 首行）的真实 git 目录；非指针文件或读取失败返回 null。 */
function readGitDirPointer(gitFile: string): string | null {
  let content: string;
  try {
    content = readFileSync(gitFile, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(GITDIR_PREFIX)) {
      const target = line.slice(GITDIR_PREFIX.length).trim();
      if (target !== "") return resolve(dirname(gitFile), target);
    }
  }
  return null;
}

/** 区根的 `.git` 是指针文件时，解析到的真实 git 目录（realpath 后）；非指针返回 null。 */
function gitDirTargetOf(zoneRoot: string): string | null {
  const pointer = readGitDirPointer(join(zoneRoot, ".git"));
  return pointer === null ? null : realpathDeep(pointer);
}

/**
 * 末尾悬空 symlink 的链接目标；能正常解析（目标存在）或不是 symlink 时返回 null。
 * 悬空链接 realpath 会失败，但写操作会穿到链接目标（创建目标文件）——必须按目标路径重判区。
 */
function danglingLinkTarget(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) return null;
  try {
    realpathSync(path); // 目标存在：走正常 realpath 分支即可
    return null;
  } catch {
    return resolve(dirname(path), readlinkSync(path));
  }
}

/** target 的任一路径段命中保护段，且 target 位于 zoneRoot 之下（含嵌套，如 vendor/x/.git/）。 */
function hitsProtectedSegment(zoneRoot: string, target: string): boolean {
  const rel = relative(zoneRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  if (rel === "") return false;
  return rel.split(sep).some((segment) => PROTECTED_PATH_SEGMENTS.includes(segment.toLowerCase()));
}

/**
 * 核心判定（zoneRoot 已 realpath 规范化的内部形态）。
 * 悬空 symlink 可能成链，用 seen 集合防环；每次迭代要么返回、要么新增一个已解析路径，必然终止。
 */
function classifyRooted(zoneRootReal: string, path: string): PathZone {
  const gitDir = gitDirTargetOf(zoneRootReal);
  let current = path;
  const seen = new Set<string>();
  for (;;) {
    const raw = resolve(zoneRootReal, current);
    const real = realpathDeep(raw);

    // 0) 末尾悬空 symlink：写操作会穿到链接目标（如指向 .git），按目标路径重判
    const dangling = danglingLinkTarget(raw);
    if (dangling !== null && !seen.has(fold(dangling))) {
      seen.add(fold(dangling));
      current = dangling;
      continue;
    }

    // 1) 词法命中保护段：`.git` 目录或 gitdir 指针文件本身（嵌套也拦）
    if (hitsProtectedSegment(zoneRootReal, raw)) return "protected";
    // 2) realpath 后命中保护段：区内 symlink 指进 .git 的绕过
    if (hitsProtectedSegment(zoneRootReal, real)) return "protected";
    // 3) gitdir 指针目标：worktree 的 `.git` 指向主仓库 git 目录，该目录是 git 元数据，无条件保护
    if (gitDir !== null && pathHasPrefix(gitDir, real)) return "protected";

    // 4) 区判定：realpath 后落在区根内 = 区内，否则区外
    if (pathHasPrefix(zoneRootReal, real)) return "inside";
    return "outside";
  }
}

/** 唯一的路径区判定入口：输入路径经 realpath 解析后判定区内 / 区外 / 保护段。 */
export function classifyPathZone(zoneRoot: string, path: string): PathZone {
  return classifyRooted(realpathDeep(resolve(zoneRoot)), path);
}

/** realpath 规范化的区内解析（供写工具拿到真实落盘路径；不抛错，调用方自行先判区）。 */
export function resolveZonePath(zoneRoot: string, path: string): string {
  return realpathDeep(resolve(realpathDeep(resolve(zoneRoot)), path));
}
