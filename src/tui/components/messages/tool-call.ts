/**
 * 工具调用帧：header（名称 + 关键参数摘要）+ 结果预览（✓/✗ + 前 N 行）。
 * #24：ctrl+o 折叠/展开；展开态也有行数上限防刷屏。
 */
import { Text, truncateToWidth, visibleWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { FAILURE_MARK, MESSAGE_INDENT, STATUS_BULLET, SUCCESS_MARK, TOOL_FRAME_TOGGLE_KEY } from "../../constant/symbols.ts";
import { hex } from "../../theme/pi-tui-theme.ts";
import { layOutBlock, summarizeArgs } from "./block-layout.ts";

/** 折叠态结果预览的最大行数。 */
const RESULT_PREVIEW_LINES = 5;
/** 展开态的最大行数（超出显示截断标记；#37 会在执行层做统一字节护栏）。 */
const EXPANDED_MAX_LINES = 200;

interface ToolResultState {
  ok: boolean;
  output: string;
}

export class ToolCallComponent implements Component {
  private readonly name: string;
  private readonly args: Record<string, unknown>;
  private result: ToolResultState | undefined;
  private expanded = false;

  constructor(name: string, args: Record<string, unknown>) {
    this.name = name;
    this.args = args;
  }

  setResult(ok: boolean, output: string): void {
    this.result = { ok, output };
  }

  /** #24：折叠/展开切换。返回切换后状态。 */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    this.invalidate();
    return this.expanded;
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
    const cap = this.expanded ? EXPANDED_MAX_LINES : RESULT_PREVIEW_LINES;
    // 折叠态取头（预览开头），展开态取尾（长日志尾部最有用，对齐 kimi-code）
    const shown = this.expanded ? outputLines.slice(-cap) : outputLines.slice(0, cap);
    const body = new Text(shown.join("\n"), 0, 0).render(contentWidth);
    const lines = body.map((line, i) => MESSAGE_INDENT + (i === 0 ? mark : "  ") + line);
    const pushHint = (text: string): void => {
      lines.push(MESSAGE_INDENT + "  " + hex("textMuted")(text));
    };
    const hidden = outputLines.length - shown.length;
    if (hidden > 0) {
      pushHint(this.expanded ? `… (${hidden} earlier lines truncated)` : `… (${hidden} more lines)`);
    }
    if (outputLines.length > RESULT_PREVIEW_LINES) {
      pushHint(this.expanded ? `${TOOL_FRAME_TOGGLE_KEY} 折叠` : `${TOOL_FRAME_TOGGLE_KEY} 展开`);
    }
    return lines;
  }
}
