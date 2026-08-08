/**
 * 工具输出统一护栏（#37，#8 清单）：单工具结果行数/字节双阈值 +
 * [...truncated] 标记。在 ToolExecutor 层一次收口，各工具不自行截断。
 */

/** 单工具结果上限：50KB（参考 #3 调研的 ToolResultBuilder）。 */
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
/** 行数上限。 */
export const TOOL_OUTPUT_MAX_LINES = 2000;

export const TRUNCATED_MARKER = "[...truncated]";

export function truncateToolOutput(output: string): string {
  let result = output;

  const lines = result.split("\n");
  if (lines.length > TOOL_OUTPUT_MAX_LINES) {
    result = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n") + `\n${TRUNCATED_MARKER} (${lines.length - TOOL_OUTPUT_MAX_LINES} more lines)`;
  }

  if (Buffer.byteLength(result, "utf8") > TOOL_OUTPUT_MAX_BYTES) {
    // 按码点切，不劈 surrogate pair；阈值是近似值（护栏不是精确计量）
    result = [...result].slice(0, TOOL_OUTPUT_MAX_BYTES).join("") + `\n${TRUNCATED_MARKER} (byte limit)`;
  }

  return result;
}
