/**
 * welcome 块：启动时展示工具名、模型、工作区与提示语。
 * 更完整的 banner 形态属于 #19。
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
    const lines = [
      "",
      hex("textStrong")(` ${this.info.toolName}`) + hex("textMuted")(` v${this.info.version}`),
      hex("textDim")(` model: ${this.info.model} · cwd: ${this.info.cwd}`),
      hex("textMuted")(" 输入消息开始对话，/ 查看命令"),
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}
