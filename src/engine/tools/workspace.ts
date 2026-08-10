/** 工作区路径收口：所有文件工具的 path 参数都必须落在工作区内。实现委托给 zone.ts（#74 唯一入口）。 */
import { classifyPathZone, resolveZonePath } from "../zone.ts";

/** 边界判定原语：tools 的写入收口与 approval 规则引擎共用这一份（#74：区判定唯一入口）。 */
export function isInsideWorkspace(workspace: string, path: string): boolean {
  return classifyPathZone(workspace, path) === "inside";
}

/** 解析到 realpath 规范化的区内路径；区外或保护段一律抛错（throw-on-escape 语义，含 #74 保护段）。 */
export function resolveInside(workspace: string, path: string): string {
  const zone = classifyPathZone(workspace, path);
  if (zone !== "inside") {
    throw new Error(
      zone === "protected" ? `path is protected (denied): ${path}` : `path escapes workspace: ${path}`,
    );
  }
  return resolveZonePath(workspace, path);
}
