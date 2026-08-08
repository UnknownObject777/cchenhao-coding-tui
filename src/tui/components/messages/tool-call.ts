/**
 * 工具调用帧：header（名称 + 关键参数摘要）+ 结果预览（✓/✗ + 前 N 行）。
 * 对齐 kimi-code components/messages/tool-call.ts 的迷你版；
 * 折叠/展开交互属于 #24，这里只有固定预览。
 */
import { Text, truncateToWidth, visibleWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { FAILURE_MARK, MESSAGE_INDENT, STATUS_BULLET, SUCCESS_MARK } from "../../constant/symbols.ts";
import { hex } from "../../theme/pi-tui-theme.ts";
import { layOutBlock } from "./block-layout.ts";

/** 结果预览的最大行数（#24 的展开/折叠会接管完整视图）。 */
const RESULT_PREVIEW_LINES = 5;
/** header 参数摘要的最大字符数。 */
const MAX_ARG_SUMMARY_LENGTH = 60;

interface ToolResultState {
  ok: boolean;
  output: string;
}

/** 取第一个字符串参数当摘要（path/command/content 都是首个）；无字符串参数则不显示。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const firstString = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  if (firstString === undefined) return "";
  const oneLine = firstString.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ARG_SUMMARY_LENGTH ? oneLine.slice(0, MAX_ARG_SUMMARY_LENGTH) + "…" : oneLine;
}

export class ToolCallComponent implements Component {
  private readonly name: string;
  private readonly args: Record<string, unknown>;
  private result: ToolResultState | undefined;

  constructor(name: string, args: Record<string, unknown>) {
    this.name = name;
    this.args = args;
  }

  setResult(ok: boolean, output: string): void {
    this.result = { ok, output };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const summary = summarizeArgs(this.args);
    const header =
      hex("textDim")(STATUS_BULLET) +
      hex("textStrong")(this.name) +
      (summary.length > 0 ? hex("textMuted")(` ${summary}`) : "");

    const lines = ["", header];
    if (this.result !== undefined) {
      lines.push(...this.renderResult(this.result, safeWidth));
    }
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }

  private renderResult(result: ToolResultState, width: number): string[] {
    const mark = hex(result.ok ? "success" : "error")(result.ok ? SUCCESS_MARK : FAILURE_MARK);
    const output = result.output.trim();
    if (output.length === 0) {
      return [MESSAGE_INDENT + mark + hex("textMuted")("(no output)")];
    }

    // 预览行按可用宽度折行（indent + mark 的列宽）
    const contentWidth = Math.max(1, width - visibleWidth(MESSAGE_INDENT + SUCCESS_MARK));
    const outputLines = output.split("\n");
    const preview = outputLines.slice(0, RESULT_PREVIEW_LINES);
    const body = new Text(preview.join("\n"), 0, 0).render(contentWidth);
    const lines = body.map((line, i) => MESSAGE_INDENT + (i === 0 ? mark : "  ") + line);
    const remaining = outputLines.length - preview.length;
    if (remaining > 0) {
      lines.push(MESSAGE_INDENT + "  " + hex("textMuted")(`… (${remaining} more lines)`));
    }
    return lines;
  }
}
