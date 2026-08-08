/**
 * 思考流块（#20）：assistant.think 的折叠渲染——单行淡化摘要，
 * 不混进正式回复的 Markdown 块。对齐 kimi-code components/messages/thinking 的迷你版。
 */
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { MESSAGE_INDENT, STATUS_BULLET } from "../../constant/symbols.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

/** 折叠摘要的最大字符数。 */
const THINKING_PREVIEW_CHARS = 60;

export class ThinkingComponent implements Component {
  private text = "";

  /** 流式入口：think delta 累积后的全量文本。 */
  updateContent(text: string): void {
    this.text = text.trim();
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.text.length === 0) return [];

    const safeWidth = Math.max(1, width);
    const firstLine = this.text.split("\n").find((line) => line.trim() !== "") ?? "";
    const folded = this.text.length > firstLine.length || firstLine.length > THINKING_PREVIEW_CHARS;
    const preview = firstLine.slice(0, THINKING_PREVIEW_CHARS) + (folded ? " …" : "");

    const lines = [
      "",
      hex("textMuted")(STATUS_BULLET) + hex("textDim")("thinking"),
      MESSAGE_INDENT + hex("textMuted")(preview),
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}
