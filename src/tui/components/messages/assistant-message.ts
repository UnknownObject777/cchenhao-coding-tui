/**
 * assistant 消息块：Markdown 内容 + ● bullet，支持流式 updateContent。
 * 对齐 kimi-code components/messages/assistant-message.ts 的迷你版（无 transient、无渲染缓存）。
 */
import {
  Container,
  Markdown,
  visibleWidth,
  type Component,
} from "../../../../vendor/pi-tui/src/index.ts";
import { STATUS_BULLET } from "../../constant/symbols.ts";
import { createMarkdownTheme, hex } from "../../theme/pi-tui-theme.ts";
import { layOutBlock } from "./block-layout.ts";

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
    return layOutBlock(safeWidth, hex("text")(STATUS_BULLET), contentLines);
  }
}
