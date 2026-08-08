/**
 * 审批缝（#5 决策）：Loop 在 tool.call 发布后、executor.execute 前 await 它。
 * EventBus 保持单向——gate 是注入的异步接口，不是事件回环（ADR-0001）。
 * 组合形态（规则引擎 + 会话记忆 + UI/print 应答源）在 bootstrap 装配，见 #25–#28。
 */

/** "always" 由 gate 内部转成会话记忆，对 Loop 等价于 allow。 */
export type ApprovalDecision = "allow" | "always" | "deny";

export interface ApprovalCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ApprovalGate {
  /** 实现方自带超时兜底，防 loop 死挂。 */
  request(call: ApprovalCall): Promise<ApprovalDecision>;
}

/** 默认 gate：全放行（现状保持；未装配审批时使用）。 */
export const allowAllGate: ApprovalGate = {
  request: () => Promise.resolve("allow"),
};
