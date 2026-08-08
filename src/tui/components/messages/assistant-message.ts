/**
 * assistant 消息块：Markdown 内容 + ● bullet，支持流式 updateContent。
 * 对齐 kimi-code components/messages/assistant-message.ts 的迷你版（无 transient、无渲染缓存）。
 */
import chalk from "chalk";

import {
  Container,
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "../../../../vendor/pi-tui/src/index.ts";
import { MESSAGE_INDENT, STATUS_BULLET } from "../../constant/symbols.ts";
import { createMarkdownTheme } from "../../theme/pi-tui-theme.ts";
import { currentTheme } from "../../theme/theme.ts";

export class AssistantMessageComponent implements Component {
  private readonly container = new Container();
  private markdown: Markdown | undefined;
  private lastText = "";

  /** 流式入口：delta 累积后的全量文本传进来，内部按需 setText。 */
  updateContent(text: string): void {
    const displayText = text.trim();
    if (displayText === this.lastText) return;
    this.lastText = displayText;

    if (displayText.length === 0) {
      this.container.clear();
      this.markdown = undefined;
      return;
    }
    if (this.markdown === undefined) {
      this.markdown = new Markdown(displayText, 0, 0, createMarkdownTheme());
      this.container.addChild(this.markdown);
      return;
    }
    this.markdown.setText(displayText);
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.lastText.length === 0) return [];

    const safeWidth = Math.max(1, width);
    const contentWidth = Math.max(1, safeWidth - visibleWidth(STATUS_BULLET));
    const contentLines = this.container.render(contentWidth);

    const bullet = chalk.hex(currentTheme.color("text"))(STATUS_BULLET);
    const lines = ["", ...contentLines.map((line, i) => (i === 0 ? bullet : MESSAGE_INDENT) + line)];
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}
