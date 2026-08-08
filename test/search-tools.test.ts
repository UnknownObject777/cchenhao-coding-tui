import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { registerBuiltinTools } from "../src/engine/tools/builtins.ts";
import { globToRegExp } from "../src/engine/tools/search.ts";
import { TOOL_OUTPUT_MAX_LINES, truncateToolOutput, TRUNCATED_MARKER } from "../src/engine/tools/truncate.ts";

describe("unified output guard (#37)", () => {
  it("caps lines with a marker", () => {
    const output = Array.from({ length: TOOL_OUTPUT_MAX_LINES + 10 }, (_, i) => `line${i}`).join("\n");
    const out = truncateToolOutput(output);
    expect(out).toContain("line0");
    expect(out).not.toContain(`line${TOOL_OUTPUT_MAX_LINES + 9}`);
    expect(out).toContain(TRUNCATED_MARKER);
    expect(out).toContain("10 more lines");
  });

  it("caps bytes with a marker", () => {
    const out = truncateToolOutput("x".repeat(60 * 1024));
    expect(out).toContain(TRUNCATED_MARKER);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(60 * 1024);
  });

  it("executor applies the guard to tool results", async () => {
    const executor = new ToolExecutor();
    executor.register({
      name: "noisy",
      description: "d",
      parameters: {},
      execute: () => Array.from({ length: 3000 }, (_, i) => `r${i}`).join("\n"),
    });
    const result = await executor.execute("noisy", {});
    expect(result.output).toContain(TRUNCATED_MARKER);
  });
});

describe("search tools (#33, #34)", () => {
  let dir: string;
  let executor: ToolExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "search-tools-"));
    await mkdir(join(dir, "src/nested"), { recursive: true });
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export const apple = 1;\nexport const banana = 2;\n");
    await writeFile(join(dir, "src/nested/b.ts"), "// banana here\n");
    await writeFile(join(dir, "README.md"), "# demo banana\n");
    await writeFile(join(dir, "node_modules/pkg/c.js"), "banana in deps\n");
    executor = new ToolExecutor();
    registerBuiltinTools(executor, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("list_files lists relative paths with dirs trailing /, skipping node_modules", async () => {
    const result = await executor.execute("list_files", {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/");
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("src/nested/b.ts");
    expect(result.output).not.toContain("node_modules");
  });

  it("list_files respects depth and path args", async () => {
    const shallow = await executor.execute("list_files", { depth: 1 });
    expect(shallow.output).not.toContain("src/nested/b.ts");

    const scoped = await executor.execute("list_files", { path: "src" });
    expect(scoped.output).toContain("nested/b.ts");
  });

  it("glob matches ** and * patterns", async () => {
    const result = await executor.execute("glob", { pattern: "src/**/*.ts" });
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("src/nested/b.ts");
    expect(result.output).not.toContain("README.md");
  });

  it("globToRegExp unit shape", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
  });

  it("grep finds path:line:content, respects glob filter and ignores deps", async () => {
    const result = await executor.execute("grep", { pattern: "banana" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/a.ts:2:export const banana = 2;");
    expect(result.output).toContain("src/nested/b.ts:1:// banana here");
    expect(result.output).not.toContain("node_modules");

    const tsOnly = await executor.execute("grep", { pattern: "banana", glob: "*.ts" });
    expect(tsOnly.output).not.toContain("README.md");
  });

  it("grep with an invalid regex returns a tool error, not a crash", async () => {
    const result = await executor.execute("grep", { pattern: "([bad" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("tool grep failed");
  });

  it("search tools cannot escape the workspace", async () => {
    const result = await executor.execute("list_files", { path: "../.." });
    expect(result.ok).toBe(false);
  });
});
