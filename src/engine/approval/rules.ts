/**
 * 分级规则引擎（#25，#5 决策第 3 条）：表驱动、纯函数、不放 UI。
 * allow = 自动放行；confirm = 必须问一次；deny = 强制拒绝（--yes 也不放行，#27）。
 * 工具分类（read/write/command）由 ToolDefinition.approval 自声明传入，本模块不维护工具名清单。
 */
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

/** run_command 危险 pattern（命中即拒绝，不问）：删、推、提权、格式化。 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+push\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdel\s+\/[fq]/i,
  /\bformat\s+[a-z]:/i,
];

export function classifyCall(
  call: ApprovalCall,
  workspace: string,
  kind: ToolApprovalKind | undefined,
): RuleLevel {
  if (kind === "read") return "allow";

  if (kind === "write") {
    // 写工具约定首参为 path：路径必须在工作区内，否则 deny
    const path = typeof call.args["path"] === "string" ? call.args["path"] : undefined;
    if (path === undefined || !isInsideWorkspace(workspace, path)) return "deny";
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
