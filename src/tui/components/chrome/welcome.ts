/**
 * welcome 块：启动时展示工具名、模型、工作区与提示语（#19：banner 框线）。
 */
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export interface WelcomeInfo {
  toolName: string;
  version: string;
  model: string;
  cwd: string;
}

export class WelcomeComponent implements Component {
  private readonly info: WelcomeInfo;

  constructor(info: WelcomeInfo) {
    this.info = info;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const title = ` ${this.info.toolName} v${this.info.version} `;
    const ruleWidth = Math.max(title.length, Math.min(safeWidth, 60));
    const rule = hex("border")("─".repeat(ruleWidth));
    const lines = [
      "",
      rule,
      hex("textStrong")(title),
      hex("textDim")(` model: ${this.info.model} · cwd: ${this.info.cwd}`),
      hex("textMuted")(" 输入消息开始对话，/ 查看命令"),
      rule,
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}
