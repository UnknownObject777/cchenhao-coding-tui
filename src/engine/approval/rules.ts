/**
 * 分级规则引擎（#25，#5 决策第 3 条）：表驱动、纯函数、不放 UI。
 * allow = 自动放行；confirm = 必须问一次；deny = 强制拒绝（--yes 也不放行，#27）。
 * 工具分类（read/write/command）由 ToolDefinition.approval 自声明传入，本模块不维护工具名清单。
 * 自举安全（#63）：保护路径（.git）写/改一律 deny；关键配置文件强制 confirm（记忆旁路见 composed-gate）。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isInsideWorkspace } from "../tools/workspace.ts";
import type { ToolApprovalKind } from "../tools/executor.ts";
import type { ApprovalCall } from "./gate.ts";

export type RuleLevel = "allow" | "confirm" | "deny";

/** run_command 无害 pattern（命中即放行）：只读/构建/测试类。 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^(ls|dir|pwd|cat|type|echo|which|where)\b/i,
  /^git\s+(status|log|diff|show|branch|remote\s+-v)\b/i,
  /^npm\s+(test|run|ls|list|outdated|view)\b/,
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

/** 保护路径段（#63）：工作区内也不可写的目录——.git 仓库元数据。段名大小写不敏感（Windows FS）。 */
const PROTECTED_PATH_SEGMENTS = [".git"];

/**
 * 关键文件（#63）：写操作强制 confirm、`a` 也不入会话记忆——改它们会改变构建/测试门槛
 * （package/tsconfig）或 mini-agent 自身行为（.agent.md 系统提示、.agents 技能、AGENTS.md、CI）。
 */
export const CRITICAL_WRITE_BASENAMES = ["package.json", "package-lock.json", "tsconfig.json", ".agent.md", "AGENTS.md"];
export const CRITICAL_WRITE_SEGMENTS = [".github", ".agents"];

/** 相对工作区路径（供区内/保护段判定；越界返回 "../…" 形态由调用方处理）。 */
function workspaceRelative(workspace: string, path: string): string {
  const root = resolve(workspace);
  return relative(root, resolve(root, path));
}

/**
 * 相对工作区解析后任一路径段命中保护段（.git/…，含嵌套如 vendor/x/.git/）→ 禁止写。
 * 越界由 isInsideWorkspace 负责，本函数只处理区内路径。
 */
function isProtectedWritePath(workspace: string, path: string): boolean {
  const rel = workspaceRelative(workspace, path).toLowerCase();
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return PROTECTED_PATH_SEGMENTS.some((seg) => rel.split(sep).includes(seg));
}

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
): RuleLevel {
  if (kind === "read") return "allow";

  if (kind === "write") {
    // 写工具约定首参为 path：路径必须在工作区内，且不得触及保护段（.git，#63）
    const path = typeof call.args["path"] === "string" ? call.args["path"] : undefined;
    if (path === undefined || !isInsideWorkspace(workspace, path)) return "deny";
    if (isProtectedWritePath(workspace, path)) return "deny";
    return "confirm";
  }

  if (kind === "command") {
    const command = typeof call.args["command"] === "string" ? call.args["command"].trim() : "";
    if (DANGEROUS_COMMAND_PATTERNS.some((p) => p.test(command))) return "deny";
    if (SAFE_COMMAND_PATTERNS.some((p) => p.test(command))) return "allow";
    return "confirm";
  }

  // 未注册/未声明分类的工具：按 confirm 处理（安全缺省，不静默放行）
  return "confirm";
}
