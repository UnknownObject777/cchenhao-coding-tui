/**
 * 审批组合体（#5 决策第 3/4 条）：规则引擎 + 会话级「始终允许」记忆 + 应答源。
 * 应答源由装配侧给：TUI 问用户（#28）、print 看 --yes（#27）。
 */
import type { EventBus } from "../events.ts";
import { publishApprovalRequest, type ApprovalCall, type ApprovalDecision, type ApprovalGate } from "./gate.ts";
import { classifyCall } from "./rules.ts";

/** confirm 级别时如何拿答案（UI 交互 / --yes 策略）。 */
export interface ApprovalAnswerer {
  ask(call: ApprovalCall): Promise<ApprovalDecision>;
}

export interface ComposedGateDeps {
  bus: EventBus;
  workspace: string;
  answerer: ApprovalAnswerer;
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

export function createComposedGate(deps: ComposedGateDeps): ApprovalGate {
  const remembered = new Set<string>();

  return {
    async request(call: ApprovalCall): Promise<ApprovalDecision> {
      const level = classifyCall(call, deps.workspace);
      if (level === "allow") return "allow";
      if (level === "deny") {
        publishApprovalRequest(deps.bus, call, "deny");
        return "deny";
      }
      if (remembered.has(memoryKey(call))) return "allow";

      publishApprovalRequest(deps.bus, call, "confirm");
      const decision = await deps.answerer.ask(call);
      if (decision === "always") remembered.add(memoryKey(call));
      return decision;
    },
  };
}
