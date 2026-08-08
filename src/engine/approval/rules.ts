/**
 * 分级规则引擎（#25，#5 决策第 3 条）：表驱动、纯函数、不放 UI。
 * allow = 自动放行；confirm = 必须问一次；deny = 强制拒绝（--yes 也不放行，#27）。
 */
import { resolve, sep } from "node:path";
import type { ApprovalCall } from "./gate.ts";

export type RuleLevel = "allow" | "confirm" | "deny";

/** 只读工具：自动放行。后续 list/grep/glob/web_*（#33–#36）往这里加。 */
const READ_ONLY_TOOLS = new Set(["read_file"]);

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

/** 写文件工具：路径必须在工作区内，否则 deny。 */
const WRITE_TOOLS = new Set(["write_file"]);

function isInsideWorkspace(workspace: string, path: string): boolean {
  const root = resolve(workspace);
  const full = resolve(root, path);
  return full === root || full.startsWith(root + sep);
}

export function classifyCall(call: ApprovalCall, workspace: string): RuleLevel {
  if (READ_ONLY_TOOLS.has(call.name)) return "allow";

  if (WRITE_TOOLS.has(call.name)) {
    const path = typeof call.args["path"] === "string" ? call.args["path"] : undefined;
    if (path === undefined || !isInsideWorkspace(workspace, path)) return "deny";
    return "confirm";
  }

  if (call.name === "run_command") {
    const command = typeof call.args["command"] === "string" ? call.args["command"].trim() : "";
    if (DANGEROUS_COMMAND_PATTERNS.some((p) => p.test(command))) return "deny";
    if (SAFE_COMMAND_PATTERNS.some((p) => p.test(command))) return "allow";
    return "confirm";
  }

  return "confirm";
}
