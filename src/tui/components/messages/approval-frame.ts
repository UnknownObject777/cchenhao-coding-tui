/** 审批帧：消息区内的 y/n/a/esc 确认块（#12 原型形态 = 内联帧，#28 正式接入）。 */
import type { ApprovalCall, ApprovalDecision } from "../../../engine/approval/gate.ts";
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { FAILURE_MARK, MESSAGE_INDENT, STATUS_BULLET, SUCCESS_MARK } from "../../constant/symbols.ts";
import { hex } from "../../theme/pi-tui-theme.ts";
import { summarizeArgs } from "./block-layout.ts";

/** 审批帧内 diff 预览的最大行数（超出显示省略标记；不做语法高亮，#62）。 */
const MAX_DIFF_LINES = 30;

export class ApprovalFrameComponent implements Component {
  private readonly call: ApprovalCall;
  private decision: ApprovalDecision | undefined;

  constructor(call: ApprovalCall) {
    this.call = call;
  }

  /** 回答后定格帧面（✓ 已允许 / ✗ 已拒绝；always 显示为已允许·本会话不再问）。 */
  settle(decision: ApprovalDecision): void {
    this.decision = decision;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const summary = summarizeArgs(this.call.args);
    const head = hex("borderFocus")(STATUS_BULLET) + hex("warning")(this.call.name) +
      (summary ? hex("textMuted")(` ${summary}`) : "");

    let body: string;
    if (this.decision === undefined) {
      body =
        hex("textStrong")("等待审批 ") +
        hex("text")("[y]") + hex("textDim")(" 允许  ") +
        hex("text")("[n]") + hex("textDim")(" 拒绝  ") +
        hex("text")("[a]") + hex("textDim")(" 始终允许  ") +
        hex("text")("[esc]") + hex("textDim")(" 拒绝");
    } else if (this.decision === "deny") {
      body = hex("error")(FAILURE_MARK + "已拒绝");
    } else {
      body = hex("success")(SUCCESS_MARK + (this.decision === "always" ? "已允许（本会话不再询问）" : "已允许"));
    }

    const lines = ["", head];

    // 写前 diff 预览（#62）：- 行红、+ 行绿、其余灰；截断到 MAX_DIFF_LINES 行。
    const diff = this.call.diff;
    if (diff !== undefined && diff !== "") {
      const diffLines = diff.split("\n");
      for (const line of diffLines.slice(0, MAX_DIFF_LINES)) {
        const prefix = line[0];
        const color = prefix === "+" ? hex("success") : prefix === "-" ? hex("error") : hex("textMuted");
        lines.push(MESSAGE_INDENT + color(line));
      }
      if (diffLines.length > MAX_DIFF_LINES) {
        lines.push(MESSAGE_INDENT + hex("textMuted")(`… 省略 ${diffLines.length - MAX_DIFF_LINES} 行 diff`));
      }
    }

    lines.push(MESSAGE_INDENT + body);
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}
