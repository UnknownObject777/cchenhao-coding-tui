/**
 * 消息块共用布局：首行 bullet、余行等宽缩进、逐行按视口截断。
 * 三个消息块组件（user/assistant/tool-call）共用，改动布局只动这里。
 */
import { truncateToWidth, visibleWidth } from "../../../../vendor/pi-tui/src/index.ts";

/** bullet 行 + 缩进行的统一拼装：lines[0] 前接 bullet，其余前接与 bullet 等宽的空格。 */
export function layOutBlock(width: number, bullet: string, contentLines: string[]): string[] {
  const safeWidth = Math.max(1, width);
  const indent = " ".repeat(visibleWidth(bullet));
  const lines = ["", ...contentLines.map((line, i) => (i === 0 ? bullet : indent) + line)];
  return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
}

/** bullet 的可见宽度（供内容折行计算）。 */
export function bulletWidth(bullet: string): number {
  return visibleWidth(bullet);
}
