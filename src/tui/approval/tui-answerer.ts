/**
 * TUI 应答源（#28）：把审批问题渲染成消息区内联帧，劫持 y/n/a/esc 回答。
 * loop 在 gate 上 await，回答前 turn 自然暂停。
 * 自带超时兜底（gate 契约：防 loop 死挂），超时按拒绝处理。
 */
import type { ApprovalAnswerer } from "../../engine/approval/composed-gate.ts";
import type { ApprovalCall, ApprovalDecision } from "../../engine/approval/gate.ts";
import { matchesKey, type Container, type TUI } from "../../../vendor/pi-tui/src/index.ts";
import { ApprovalFrameComponent } from "../components/messages/approval-frame.ts";

/** 审批等待上限（默认 2 分钟，超时自动拒绝）。 */
const DEFAULT_TIMEOUT_MS = 120_000;

interface PendingApproval {
  frame: ApprovalFrameComponent;
  resolve: (decision: ApprovalDecision) => void;
  timeout: NodeJS.Timeout;
}

export class TuiApprovalAnswerer implements ApprovalAnswerer {
  private readonly tui: TUI;
  private readonly chat: Container;
  private readonly timeoutMs: number;
  private pending: PendingApproval | undefined;

  constructor(deps: { tui: TUI; chat: Container; timeoutMs?: number }) {
    this.tui = deps.tui;
    this.chat = deps.chat;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 挂到 TUI 输入流：有待答审批时 y/n/a/esc 优先于 editor 被消费。 */
  attach(): void {
    // InputListener 类型未从 pi-tui 导出，显式标注参数与返回形状
    this.tui.addInputListener((data: string): { consume: true } | undefined => {
      if (this.pending === undefined) return undefined;
      const decision = this.mapKey(data);
      if (decision === undefined) return undefined;
      this.answer(decision);
      return { consume: true };
    });
  }

  ask(call: ApprovalCall): Promise<ApprovalDecision> {
    const frame = new ApprovalFrameComponent(call);
    this.chat.addChild(frame);
    this.tui.requestRender();

    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => this.answer("deny"), this.timeoutMs);
      this.pending = { frame, resolve, timeout };
    });
  }

  private mapKey(data: string): ApprovalDecision | undefined {
    if (data === "y" || data === "Y") return "allow";
    if (data === "a" || data === "A") return "always";
    if (data === "n" || data === "N") return "deny";
    if (matchesKey(data, "escape")) return "deny";
    return undefined;
  }

  private answer(decision: ApprovalDecision): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.frame.settle(decision);
    this.tui.requestRender();
    pending.resolve(decision);
  }
}
