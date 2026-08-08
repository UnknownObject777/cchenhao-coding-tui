/**
 * footer 状态栏：单行模型 + 工作区。
 * 迷你版只渲染静态信息；上下文占用、审批模式等增强属于 #48（信息由 bootstrap 注入）。
 */
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export interface FooterInfo {
  model: string;
  cwd: string;
}

export class FooterComponent implements Component {
  private readonly info: FooterInfo;

  constructor(info: FooterInfo) {
    this.info = info;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const line = hex("textDim")(` ${this.info.model} · ${this.info.cwd}`);
    return [truncateToWidth(line, Math.max(1, width), "…")];
  }
}
