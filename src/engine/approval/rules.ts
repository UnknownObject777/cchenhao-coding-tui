/**
 * 分级规则引擎（#25，#5 决策第 3 条）：表驱动、纯函数、不放 UI。
 * allow = 自动放行；confirm = 必须问一次；deny = 强制拒绝（--yes 也不放行，#27）。
 * 工具分类（read/write/command）由 ToolDefinition.approval 自声明传入，本模块不维护工具名清单。
 * 自举安全（#63）：保护路径（.git）写/改一律 deny；关键配置文件强制 confirm（记忆旁路见 composed-gate）。
 * 出区必批（#75）：run_command 命令文本的越界意图（cd .. / 绝对路径区外 / 家目录）静态判定为出区 → confirm。
 * 笼子刻度（#87）：cage 模式（worktree 会话，区根 = worktree 根）下区内写与开发命令（test/typecheck 等）
 * 自动放行（零打扰）；出区写、git 变异（commit/merge/branch -d 等）、网络、笼子配置（package/tsconfig/AGENTS 等）
 * 永不自动批准——必走人工 confirm/deny。普通模式行为保持不变。
 */
import { relative, resolve, sep } from "node:path";
import { isInsideWorkspace } from "../tools/workspace.ts";
import { classifyPathZone } from "../zone.ts";
import type { ToolApprovalKind } from "../tools/executor.ts";
import type { ApprovalCall } from "./gate.ts";

export type RuleLevel = "allow" | "confirm" | "deny";

/** 审批模式（#87）：cage = worktree 自进化会话（区根 = worktree 根，区内放行）；normal = 普通会话（现状行为）。 */
export type ApprovalMode = "normal" | "cage";

/** run_command 无害 pattern（命中即放行）：只读/构建/测试类。 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^(ls|dir|pwd|cat|type|echo|which|where)\b/i,
  /^git\s+(status|log|diff|show|branch|remote\s+-v)\b/i,
  /^npm\s+(test|run|ls|list|outdated|view)\b/,
];

/** cage 模式 git 只读子集（#87）：只读 git 照常自动放行，其余 git（commit/merge/add/branch -d 等变异）一律 confirm。 */
const CAGE_GIT_READONLY: RegExp = /^git\s+(status|log|diff|show|remote\s+-v)\b/i;

/** cage 模式网络命令（#87）：命中即 confirm，永不自动放行——即使普通模式的 SAFE 表会放行（npm outdated/view）。 */
const CAGE_NETWORK_PATTERNS: RegExp[] = [
  /\b(curl|wget|ssh|scp|sftp|rsync|telnet)\b/i,
  /^git\s+(fetch|pull|clone)\b/i,
  /^npm\s+(outdated|view|install|ci|add|update|init)\b/,
  /^npx\b/,
  /^pip\d?\s+install\b/,
  /^go\s+get\b/,
  /^cargo\s+(install|add|update)\b/,
];

/** cage 模式开发命令（#87）：typecheck/测试/构建类本地命令直接自动放行（零打扰；不发网络）。 */
const CAGE_DEV_COMMAND_PATTERNS: RegExp[] = [
  /^tsc\b/,
  /^vitest\b/,
  /^jest\b/,
  /^mocha\b/,
  /^eslint\b/,
  /^prettier\b/,
];

/** run_command 危险 pattern（命中即拒绝，不问）：删、推、提权、格式化、改/毁 .git（#63）。 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+push\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdel\s+\/[fq]/i,
  /\bformat\s+[a-z]:/i,
  // 自举保护（#63）：写 .git（config/reset 改 index）或毁工作树（clean / checkout 丢弃）一律拒绝
  /\bgit\s+(config|reset|clean)\b/i,
  /\bgit\s+checkout\s+(--|\.(?=\s|$))/i,
];

/** 相对工作区路径（供关键文件判定；越界返回 "../…" 形态由调用方处理）。 */
function workspaceRelative(workspace: string, path: string): string {
  const root = resolve(workspace);
  return relative(root, resolve(root, path));
}

/**
 * 命令文本越界静态判定（#75，启发式）。
 * #71 决策：bash 静态判定有 8/15 subagent 绕过的实证，只当 UX 启发式——目标是「可见+必批」：
 * 命中出区意图（cd .. / 绝对路径指向区外 / 家目录引用）即不允许自动放行，交人工审批；
 * 不可绕过属于 future work 的 OS 层沙箱。误报方向一律取保守（出区）。
 */
export type CommandZone = "inside" | "outside";

/** Windows 语义的反斜杠根路径 / UNC；POSIX 上反斜杠是转义符，不做绝对路径判定。 */
const IS_WIN32 = process.platform === "win32";

/** 家目录引用形态（区外）：POSIX ~、$HOME/${HOME}；cmd 的 %USERPROFILE%；pwsh/git-bash 的 $env:USERPROFILE / $USERPROFILE。 */
const HOME_REF_PATTERNS: RegExp[] = [
  /~(?=[\\/]|$)/,
  /\$\{?HOME\}?(?=[\\/]|$)/,
  /%USERPROFILE%(?=[\\/]|$)/i,
  /\$env:USERPROFILE(?=[\\/]|$)/i,
  /\$USERPROFILE(?=[\\/]|$)/i,
];

/** 去掉 token 的成对引号与前导未闭合引号（按空白切分后含空格的引号串常被切开，启发式够用）。 */
function stripQuotes(token: string): string {
  let t = token;
  for (;;) {
    if (t.length < 2) break;
    const first = t[0];
    if ((first === '"' || first === "'") && t.endsWith(first)) {
      t = t.slice(1, -1);
      continue;
    }
    break;
  }
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'")) t = t.slice(1);
  return t;
}

/** 取 token 的赋值右值（--outDir=../dist → ../dist；VAR=x 同理）；无 = 时原样返回。 */
function flagValue(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(eq + 1);
}

/** token 是否为绝对路径：POSIX / 前缀、Windows 盘符/UNC/反斜杠根。 */
function isAbsoluteToken(token: string): boolean {
  if (token.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (IS_WIN32 && token.startsWith("\\")) return true;
  return false;
}

/** 相对路径段的向上逃逸判定：任一段落到区根之上（.. 超过前面段数）即出区；a/../b 这类平衡段不算。 */
function escapesViaDotDot(token: string): boolean {
  let depth = 0;
  for (const seg of token.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

/**
 * 命令级出区判定：逐 token 找越界意图。绝对路径走 #74 唯一区判定入口（realpath 判区，
 * 含保护段）；相对路径看 .. 上溯；家目录引用一律按出区（保守）。未见意图 → 区内。
 */
export function classifyCommandZone(workspace: string, command: string): CommandZone {
  for (const raw of command.split(/\s+/)) {
    const token = stripQuotes(flagValue(raw));
    if (token === "") continue;
    if (HOME_REF_PATTERNS.some((p) => p.test(token))) return "outside";
    if (isAbsoluteToken(token)) {
      if (classifyPathZone(workspace, token) !== "inside") return "outside";
      continue;
    }
    if (escapesViaDotDot(token)) return "outside";
  }
  return "inside";
}

/**
 * 关键文件（#63）：写操作强制 confirm、`a` 也不入会话记忆——改它们会改变构建/测试门槛
 * （package/tsconfig）或 mini-agent 自身行为（.agent.md 系统提示、.agents 技能、AGENTS.md、CI）。
 */
export const CRITICAL_WRITE_BASENAMES = ["package.json", "package-lock.json", "tsconfig.json", ".agent.md", "AGENTS.md"];
export const CRITICAL_WRITE_SEGMENTS = [".github", ".agents"];

/** 关键文件判定：basename 精确命中或首段命中（.github/…、.agents/…）。仅对工作区内路径有意义。 */
export function isCriticalConfigPath(workspace: string, path: string): boolean {
  if (!isInsideWorkspace(workspace, path)) return false;
  const segments = workspaceRelative(workspace, path).split(sep);
  const base = segments[segments.length - 1] ?? "";
  const first = segments[0] ?? "";
  return CRITICAL_WRITE_BASENAMES.includes(base) || CRITICAL_WRITE_SEGMENTS.includes(first);
}

export function classifyCall(
  call: ApprovalCall,
  workspace: string,
  kind: ToolApprovalKind | undefined,
  mode: ApprovalMode = "normal",
): RuleLevel {
  if (kind === "read") return "allow";

  if (kind === "write") {
    // 写工具约定首参为 path：区判定唯一入口（#74）——区外/保护段一律 deny
    const path = typeof call.args["path"] === "string" ? call.args["path"] : undefined;
    if (path === undefined) return "deny";
    if (classifyPathZone(workspace, path) !== "inside") return "deny";
    // 笼内（#87）：区内写自动放行（零打扰），但笼子配置（构建/测试门槛与自身行为文件）永不自动批准
    if (mode === "cage" && !isCriticalConfigPath(workspace, path)) return "allow";
    return "confirm";
  }

  if (kind === "command") {
    const command = typeof call.args["command"] === "string" ? call.args["command"].trim() : "";
    if (DANGEROUS_COMMAND_PATTERNS.some((p) => p.test(command))) return "deny";
    // #75：出区必批——静态判定是启发式（可见即可，不追求不可绕过），命中出区意图绝不放行，交人工审批
    if (classifyCommandZone(workspace, command) === "outside") return "confirm";
    if (mode === "cage") {
      // 笼内 git 变异（非只读子集）与网络命令永不自动批准（#87）——先于 SAFE 表压过 allow
      if (/^git\b/i.test(command) && !CAGE_GIT_READONLY.test(command)) return "confirm";
      if (CAGE_NETWORK_PATTERNS.some((p) => p.test(command))) return "confirm";
      // 笼内开发命令（typecheck/测试/构建）直接放行
      if (CAGE_DEV_COMMAND_PATTERNS.some((p) => p.test(command))) return "allow";
    }
    if (SAFE_COMMAND_PATTERNS.some((p) => p.test(command))) return "allow";
    return "confirm";
  }

  // 未注册/未声明分类的工具：按 confirm 处理（安全缺省，不静默放行）
  return "confirm";
}
