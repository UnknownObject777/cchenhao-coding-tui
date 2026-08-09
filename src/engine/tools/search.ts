/**
 * 检索类内置工具（#33 list_files、#34 grep/glob）：纯 Node 实现，不引第三方。
 * 忽略规则是玩具级近似：固定跳过 .git/node_modules + 根 .gitignore 的简单 pattern
 * （目录名、*.ext、纯名字段匹配），不实现完整 gitignore 语义。
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutor } from "./executor.ts";
import { resolveInside } from "./workspace.ts";

const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

type IgnoreMatcher = (rel: string) => boolean;

/** 根 .gitignore 的玩具级读取：每行一个 pattern，匹配相对路径的任一段或前后缀。 */
async function loadIgnoreMatcher(workspace: string): Promise<IgnoreMatcher> {
  let patterns: string[] = [];
  try {
    const text = await readFile(join(workspace, ".gitignore"), "utf8");
    patterns = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    // 没有 .gitignore 就只跳固定项
  }
  return (rel: string) => {
    const segments = rel.split("/");
    if (segments.some((s) => ALWAYS_IGNORED.has(s))) return true;
    return patterns.some((pattern) => {
      const p = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
      if (p.includes("*")) {
        const re = new RegExp("^" + p.split("*").map(escapeRegExp).join("[^/]*") + "$");
        return segments.some((s) => re.test(s)) || re.test(rel);
      }
      return segments.some((s) => s === p) || rel.startsWith(p + "/");
    });
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** glob → RegExp：双星跨段（双星+斜杠允许零层目录），单星段内，? 单字符。 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?"; // **/ 匹配零层或多层目录
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeRegExp(ch);
      i += 1;
    }
  }
  return new RegExp("^" + out + "$");
}

interface WalkEntry {
  rel: string;
  isDir: boolean;
}

async function walk(root: string, ignore: IgnoreMatcher, maxDepth: number, maxEntries: number): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  while (queue.length > 0 && out.length < maxEntries) {
    const { rel, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    const abs = rel === "" ? root : join(root, rel);
    let children;
    try {
      children = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (out.length >= maxEntries) break;
      const childRel = rel === "" ? child.name : rel + "/" + child.name;
      if (ignore(childRel)) continue;
      const isDir = child.isDirectory();
      out.push({ rel: childRel, isDir });
      if (isDir) queue.push({ rel: childRel, depth: depth + 1 });
    }
  }
  return out;
}

async function isBinaryFile(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(buffer, 0, 1024, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return true;
  }
}

export function registerSearchTools(executor: ToolExecutor, workspace: string): void {
  executor.register({
    name: "list_files",
    description: "List files and directories under a workspace path (relative paths, dirs end with /).",
    approval: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path, default ." },
        depth: { type: "number", description: "Max depth, default 3" },
        max_entries: { type: "number", description: "Cap, default 200" },
      },
    },
    execute: async (args) => {
      const root = resolveInside(workspace, typeof args["path"] === "string" ? args["path"] : ".");
      const depth = typeof args["depth"] === "number" ? args["depth"] : 3;
      const maxEntries = typeof args["max_entries"] === "number" ? args["max_entries"] : 200;
      const ignore = await loadIgnoreMatcher(workspace);
      const entries = await walk(root, ignore, depth, maxEntries);
      return entries.map((e) => (e.isDir ? e.rel + "/" : e.rel)).sort().join("\n");
    },
  });

  executor.register({
    name: "glob",
    description: "Match files by glob pattern (** crosses directories, * within a segment).",
    approval: "read",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Relative base path, default ." },
      },
      required: ["pattern"],
    },
    execute: async (args) => {
      const pattern = String(args["pattern"]);
      const root = resolveInside(workspace, typeof args["path"] === "string" ? args["path"] : ".");
      const re = globToRegExp(pattern);
      const ignore = await loadIgnoreMatcher(workspace);
      const entries = await walk(root, ignore, Number.MAX_SAFE_INTEGER, 5000);
      return entries
        .filter((e) => !e.isDir && re.test(e.rel))
        .slice(0, 200)
        .map((e) => e.rel)
        .sort()
        .join("\n");
    },
  });

  executor.register({
    name: "grep",
    description: "Search file contents with a regular expression; output path:line:content. Skips binaries and files over 1MB.",
    approval: "read",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "Relative base path, default ." },
        glob: { type: "string", description: "Optional file glob filter, e.g. *.ts" },
        max_results: { type: "number", description: "Cap, default 100" },
      },
      required: ["pattern"],
    },
    execute: async (args) => {
      const re = new RegExp(String(args["pattern"])); // 非法正则抛错 → executor 归一为工具错误
      const root = resolveInside(workspace, typeof args["path"] === "string" ? args["path"] : ".");
      const globFilter = typeof args["glob"] === "string" ? globToRegExp(args["glob"]) : undefined;
      const maxResults = typeof args["max_results"] === "number" ? args["max_results"] : 100;
      const ignore = await loadIgnoreMatcher(workspace);
      const entries = await walk(root, ignore, Number.MAX_SAFE_INTEGER, 5000);

      const hits: string[] = [];
      for (const entry of entries) {
        if (hits.length >= maxResults) break;
        if (entry.isDir) continue;
        if (globFilter !== undefined && !globFilter.test(entry.rel)) continue;
        const abs = join(root, entry.rel);
        const info = await stat(abs).catch(() => undefined);
        if (info === undefined || info.size > 1024 * 1024) continue; // 跳过大文件
        if (await isBinaryFile(abs)) continue;
        const text = await readFile(abs, "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) {
          if (re.test(lines[i]!)) {
            hits.push(`${entry.rel}:${i + 1}:${lines[i]!.trimEnd()}`);
          }
        }
      }
      return hits.join("\n");
    },
  });
}
