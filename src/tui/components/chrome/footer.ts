/**
 * footer 状态栏：模型 + 工作区 + 上下文占用（#32）。
 * 占用经 context.usage 事件驱动（setUsage）；≥70% 预算换 warning 色。
 * 审批模式状态等增强属于 #48（信息由 bootstrap 注入）。
 */
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export interface FooterInfo {
  model: string;
  cwd: string;
}

/** 占用超过该比例时换警示色。 */
const USAGE_WARN_RATIO = 0.7;

export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);
}

export class FooterComponent implements Component {
  private readonly info: FooterInfo;
  private usage: { estimatedTokens: number; budgetTokens: number } | undefined;

  constructor(info: FooterInfo) {
    this.info = info;
  }

  setUsage(estimatedTokens: number, budgetTokens: number): void {
    this.usage = { estimatedTokens, budgetTokens };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    let line = hex("textDim")(` ${this.info.model} · ${this.info.cwd}`);
    if (this.usage !== undefined) {
      const { estimatedTokens, budgetTokens } = this.usage;
      const text = ` · ctx ${formatTokenCount(estimatedTokens)}/${formatTokenCount(budgetTokens)}`;
      line += estimatedTokens / budgetTokens >= USAGE_WARN_RATIO ? hex("warning")(text) : hex("textMuted")(text);
    }
    return [truncateToWidth(line, safeWidth, "…")];
  }
}
