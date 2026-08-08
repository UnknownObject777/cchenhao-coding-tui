import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 真实长路径的临时目录。CI 的 Windows runner 里 os.tmpdir() 带 8.3 短名
 * （RUNNER~1），recursive mkdir 对它抛 ENOENT（Node 已知问题）。
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
}
