/**
 * 审批组合体（#5 决策第 3/4 条）：规则引擎 + 会话级「始终允许」记忆 + 应答源。
 * 应答源由装配侧给：TUI 问用户（#28）、print 看 --yes（#27）。
 */
import type { EventBus } from "../events.ts";
import type { ToolApprovalKind } from "../tools/executor.ts";
import { computeWritePreview } from "../tools/diff.ts";
import type { WireRow } from "../wire.ts";
import { publishApprovalRequest, type ApprovalCall, type ApprovalDecision, type ApprovalGate } from "./gate.ts";
import { classifyCall, isCriticalConfigPath } from "./rules.ts";

/** confirm 级别时如何拿答案（UI 交互 / --yes 策略）。 */
export interface ApprovalAnswerer {
  ask(call: ApprovalCall): Promise<ApprovalDecision>;
}

export interface ComposedGateDeps {
  bus: EventBus;
  workspace: string;
  answerer: ApprovalAnswerer;
  /** 工具自声明的审批分类查询（ToolExecutor.approvalKind）；工具目录的单一事实来源。 */
  approvalKind: (name: string) => ToolApprovalKind | undefined;
  /** 会话恢复时回灌的「始终允许」记忆（#29：从 wire 的 approval.* 事件还原）。 */
  remembered?: ReadonlySet<string>;
  /** #87 笼子模式（worktree 会话）：区内写与开发命令自动放行，笼子边界永不自动批准。缺省关闭（普通模式行为不变）。 */
  cage?: boolean;
}

/** 从 wire 记录还原 always 记忆：decision=always 与同 id 的 request 配对取 memoryKey。 */
export function alwaysMemoryFrom(rows: WireRow[]): Set<string> {
  const requests = new Map<string, ApprovalCall>();
  const keys = new Set<string>();
  for (const { event } of rows) {
    if (event.type === "approval.request") {
      requests.set(event.id, { id: event.id, name: event.name, args: event.args });
    }
    if (event.type === "approval.decision" && event.decision === "always") {
      const request = requests.get(event.id);
      if (request !== undefined) keys.add(memoryKey(request));
    }
  }
  return keys;
}

/**
 * 会话记忆键：工具名 + 首字符串参数的前两段（按 #5 决策：
 * run_command 的 "npm test" 取前两段；无字符串参数退化为工具名）。
 */
export function memoryKey(call: ApprovalCall): string {
  const firstString = Object.values(call.args).find((v) => typeof v === "string");
  if (typeof firstString !== "string") return call.name;
  const head = firstString.trim().split(/\s+/).slice(0, 2).join(" ");
  return `${call.name}:${head}`;
}

/** 给写调用附加写前 diff 预览；非写调用或读不到旧内容时原样返回（预览是尽力而为，失败不影响审批）。 */
async function attachWriteDiff(
  call: ApprovalCall,
  workspace: string,
  kind: ToolApprovalKind | undefined,
): Promise<ApprovalCall> {
  if (kind !== "write") return call;
  const diff = await computeWritePreview(call, workspace);
  return diff === undefined ? call : { ...call, diff };
}

export function createComposedGate(deps: ComposedGateDeps): ApprovalGate {
  const remembered = new Set<string>(deps.remembered);

  return {
    async request(call: ApprovalCall): Promise<ApprovalDecision> {
      const kind = deps.approvalKind(call.name);
      const level = classifyCall(call, deps.workspace, kind, deps.cage === true ? "cage" : "normal");
      if (level === "allow") return "allow";
      if (level === "deny") {
        publishApprovalRequest(deps.bus, call, "deny");
        return "deny";
      }
      // 关键配置文件（#63）：改了会动构建/测试门槛或自身行为——即使答过 `a` 也每次重问，记忆旁路。
      const isCriticalWrite =
        kind === "write" && typeof call.args["path"] === "string" && isCriticalConfigPath(deps.workspace, call.args["path"]);
      if (remembered.has(memoryKey(call)) && !isCriticalWrite) return "allow";

      // diff 预览（#62）：confirm 级写调用在真发问前投影变更，随同一次 call 交给
      // 应答源（TUI 帧渲染）与 approval.request 事件（stream-json 管道可消费）。
      const preview = await attachWriteDiff(call, deps.workspace, kind);
      publishApprovalRequest(deps.bus, preview, "confirm");
      const decision = await deps.answerer.ask(preview);
      if (decision === "always" && !isCriticalWrite) remembered.add(memoryKey(call));
      return decision;
    },
  };
}
