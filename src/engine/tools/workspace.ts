/** 工作区路径收口：所有文件工具的 path 参数都必须落在工作区内。 */
import { resolve, sep } from "node:path";

/** 边界判定原语：tools 的写入收口与 approval 规则引擎共用这一份。 */
export function isInsideWorkspace(workspace: string, path: string): boolean {
  const root = resolve(workspace);
  const full = resolve(root, path);
  return full === root || full.startsWith(root + sep);
}

export function resolveInside(workspace: string, path: string): string {
  if (!isInsideWorkspace(workspace, path)) {
    throw new Error(`path escapes workspace: ${path}`);
  }
  return resolve(resolve(workspace), path);
}
