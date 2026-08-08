/** 工作区路径收口：所有文件工具的 path 参数都必须落在工作区内。 */
import { resolve, sep } from "node:path";

export function resolveInside(workspace: string, path: string): string {
  const root = resolve(workspace);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`path escapes workspace: ${path}`);
  }
  return full;
}
