/**
 * #62 极简 unified-ish 行级 diff：纯 Node、零依赖（玩具不引 diff 库）。
 * createUnifiedDiff 是纯函数（LCS 回溯 + 上下文 hunk）；
 * computeWritePreview 在审批门侧把 write_file/edit_file 的待写内容投影成 diff——
 * 只有读得到旧内容才生成（新文件没有比对基线，返回 undefined 表示「无预览」）。
 */
import { readFile } from "node:fs/promises";
import type { ApprovalCall } from "../approval/gate.ts";
import { resolveInside } from "./workspace.ts";

/** LCS 矩阵规模上限（500×500 行）：预览只服务小文件，超大输入不硬算。 */
const MAX_DIFF_CELLS = 250_000;

/** 每个 hunk 的上下文行数。 */
const CONTEXT_LINES = 3;

/** hunk 内旧/新行数（unified diff 头行的 +/- 统计；创建与聚 hunks 两处共用）。 */
function countLines(ops: DiffOp[]): { oldCount: number; newCount: number } {
  return {
    oldCount: ops.filter((op) => op.kind !== "+").length,
    newCount: ops.filter((op) => op.kind !== "-").length,
  };
}

type DiffOp = { kind: " " | "-" | "+"; text: string };

/**
 * 行级 unified-ish diff。返回 undefined 当：
 * 无实际变化（内容等价）、或输入规模超上限。
 * label 给定时输出 `--- a/<label>` / `+++ b/<label>` 头。
 */
export function createUnifiedDiff(oldText: string, newText: string, label?: string): string | undefined {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) return undefined;
  const ops = lcsOps(oldLines, newLines);
  if (!ops.some((op) => op.kind !== " ")) return undefined;

  const lines: string[] = [];
  if (label !== undefined && label !== "") {
    lines.push(`--- a/${label}`, `+++ b/${label}`);
  }
  for (const hunk of buildHunks(ops)) {
    const { oldCount, newCount } = countLines(hunk.ops);
    lines.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
    for (const op of hunk.ops) lines.push(op.kind + op.text);
  }
  return lines.join("\n");
}

/** 按调用投影待写 diff：write_file 用 args.content，edit_file 用替换结果；非写调用/读不到旧内容返回 undefined。 */
export async function computeWritePreview(call: ApprovalCall, workspace: string): Promise<string | undefined> {
  if (call.name !== "write_file" && call.name !== "edit_file") return undefined;
  const path = typeof call.args["path"] === "string" ? call.args["path"] : undefined;
  if (path === undefined) return undefined;
  let full: string;
  try {
    full = resolveInside(workspace, path);
  } catch {
    return undefined; // 越界路径：预览跟随审批规则的 deny 语义，不抛
  }
  let oldText: string;
  try {
    oldText = await readFile(full, "utf8");
  } catch {
    return undefined; // 新文件或读不到：没有可比对的基线
  }

  if (call.name === "write_file") {
    const content = typeof call.args["content"] === "string" ? call.args["content"] : undefined;
    if (content === undefined) return undefined;
    return createUnifiedDiff(oldText, content, path);
  }

  // edit_file：把替换投影到旧内容上再 diff（与工具执行的 success 路径同构）
  const oldString = typeof call.args["old_string"] === "string" ? call.args["old_string"] : undefined;
  const newString = typeof call.args["new_string"] === "string" ? call.args["new_string"] : undefined;
  if (oldString === undefined || newString === undefined || oldString === "") return undefined;
  if (!oldText.includes(oldString)) return undefined;
  const next = call.args["replace_all"] === true ? oldText.split(oldString).join(newString) : oldText.replace(oldString, newString);
  return createUnifiedDiff(oldText, next, path);
}

/** 统一换行后按行切分（尾随换行不计为一行）。 */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (body === "") return [];
  return body.split("\n");
}

/** LCS 回溯出行级操作序列（自后向前填表，自前向后回溯）。 */
function lcsOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  // dp[i*width+j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度；边界行恒 0
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const cell = i * width + j;
      if (oldLines[i]! === newLines[j]!) {
        dp[cell] = dp[(i + 1) * width + j + 1]! + 1;
      } else {
        const down = dp[(i + 1) * width + j]!;
        const right = dp[i * width + j + 1]!;
        dp[cell] = down >= right ? down : right;
      }
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i]! === newLines[j]!) {
      ops.push({ kind: " ", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      ops.push({ kind: "-", text: oldLines[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", text: newLines[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: oldLines[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "+", text: newLines[j]! });
    j += 1;
  }
  return ops;
}

/** 把变更点聚成 hunk（间隔 ≤ 2×CONTEXT 的变更合并），每 hunk 带 1 起点的行号。 */
function buildHunks(ops: DiffOp[]): Array<{ ops: DiffOp[]; oldStart: number; newStart: number }> {
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== " ") changed.push(i);
  }
  if (changed.length === 0) return [];

  const groups: Array<[number, number]> = [];
  let start = changed[0]!;
  let end = changed[0]!;
  for (let k = 1; k < changed.length; k += 1) {
    if (changed[k]! - end > 2 * CONTEXT_LINES) {
      groups.push([start, end]);
      start = changed[k]!;
      end = changed[k]!;
    } else {
      end = changed[k]!;
    }
  }
  groups.push([start, end]);

  return groups.map(([first, last]) => {
    const opStart = Math.max(0, first - CONTEXT_LINES);
    const opEnd = Math.min(ops.length - 1, last + CONTEXT_LINES);
    const hunkOps = ops.slice(opStart, opEnd + 1);
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < opStart; i += 1) {
      if (ops[i]!.kind !== "+") oldBefore += 1;
      if (ops[i]!.kind !== "-") newBefore += 1;
    }
    const { oldCount, newCount } = countLines(hunkOps);
    return {
      ops: hunkOps,
      oldStart: oldCount === 0 ? oldBefore : oldBefore + 1,
      newStart: newCount === 0 ? newBefore : newBefore + 1,
    };
  });
}
