/**
 * 消息块共用布局与小工具：首行 bullet、余行等宽缩进、逐行按视口截断、参数摘要。
 * 消息块组件（user/assistant/tool-call/approval-frame）共用，改动只动这里。
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

/** header 参数摘要的最大字符数。 */
const MAX_ARG_SUMMARY_LENGTH = 60;

/** 取第一个字符串参数当摘要（path/command/content 都是首个）；无字符串参数则不显示。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const firstString = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  if (firstString === undefined) return "";
  const oneLine = firstString.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ARG_SUMMARY_LENGTH ? oneLine.slice(0, MAX_ARG_SUMMARY_LENGTH) + "…" : oneLine;
}
