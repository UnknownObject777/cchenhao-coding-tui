/**
 * footer 状态栏（#48）：模型 + 工作区 + 审批模式 + 上下文占用。
 * 信息单源：装配时经 FooterInfo 注入（bootstrap → app.ts）；
 * 占用经 context.usage 事件驱动（setUsage），≥70% 预算换 warning 色。
 */
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export interface FooterInfo {
  model: string;
  cwd: string;
  /** 审批模式展示文案（如 "审批:交互"），装配侧单源注入（#48）。 */
  approvalLabel: string;
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
    let line =
      hex("textDim")(` ${this.info.model} · ${this.info.cwd}`) +
      hex("textMuted")(` · ${this.info.approvalLabel}`);
    if (this.usage !== undefined) {
      const { estimatedTokens, budgetTokens } = this.usage;
      const text = ` · ctx ${formatTokenCount(estimatedTokens)}/${formatTokenCount(budgetTokens)}`;
      line += estimatedTokens / budgetTokens >= USAGE_WARN_RATIO ? hex("warning")(text) : hex("textMuted")(text);
    }
    return [truncateToWidth(line, safeWidth, "…")];
  }
}
