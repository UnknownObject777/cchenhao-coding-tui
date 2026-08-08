/**
 * 工具输出统一护栏（#37，#8 清单）：单工具结果行数/字节双阈值 +
 * [...truncated] 标记。在 ToolExecutor 层一次收口，各工具不自行截断。
 */

/** 单工具结果上限：50KB（参考 #3 调研的 ToolResultBuilder）。 */
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
/** 行数上限。 */
export const TOOL_OUTPUT_MAX_LINES = 2000;

export const TRUNCATED_MARKER = "[...truncated]";

/** 按 UTF-8 字节截断（码点安全），超限加 [...truncated] 标记。 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char, "utf8");
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end) + `\n${TRUNCATED_MARKER} (byte limit)`;
}

export function truncateToolOutput(output: string): string {
  let result = output;

  const lines = result.split("\n");
  if (lines.length > TOOL_OUTPUT_MAX_LINES) {
    result = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n") + `\n${TRUNCATED_MARKER} (${lines.length - TOOL_OUTPUT_MAX_LINES} more lines)`;
  }

  return truncateBytes(result, TOOL_OUTPUT_MAX_BYTES);
}
