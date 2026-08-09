/**
 * 审批缝（#5 决策）：Loop 在 tool.call 发布后、executor.execute 前 await 它。
 * EventBus 保持单向——gate 是注入的异步接口，不是事件回环（ADR-0001）。
 * 组合形态（规则引擎 + 会话记忆 + UI/print 应答源）在 bootstrap 装配，见 #25–#28。
 */
import type { EventBus } from "../events.ts";
import type { ToolCall } from "../llm/types.ts";

/**
 * "always" 对 Loop 等价于 allow（放行本次）；把它折算成会话记忆是 gate 内部的事（#26），
 * Loop 只是把 decision 原样发布进 approval.decision 留痕。
 */
export type ApprovalDecision = "allow" | "always" | "deny";

/** #62：gate 组合体可在确认前把写调用投影成 diff，随 call 一起交给应答源与 approval.request 事件。 */
export type ApprovalCall = ToolCall & { diff?: string };

export interface ApprovalGate {
  /**
   * 实现方自带超时兜底，防 loop 死挂。
   * 装配契约：gate 组合体在 bootstrap 持有 bus，真发问（confirm）或强制拒绝（deny）前
   * 必须经 publishApprovalRequest 发布 approval.request 留痕（#5 决策第 2 条）。
   */
  request(call: ApprovalCall): Promise<ApprovalDecision>;
}

/** approval.request 的唯一发布口（level 由规则引擎判定）。 */
export function publishApprovalRequest(
  bus: EventBus,
  call: ApprovalCall,
  level: "confirm" | "deny",
): void {
  bus.emit("approval.request", {
    id: call.id,
    name: call.name,
    args: call.args,
    level,
    ...(call.diff !== undefined ? { diff: call.diff } : {}),
  });
}

/** 默认 gate：全放行（现状保持；未装配审批时使用）。 */
export const allowAllGate: ApprovalGate = {
  request: () => Promise.resolve("allow"),
};
