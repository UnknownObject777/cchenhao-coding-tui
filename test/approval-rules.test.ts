import { describe, expect, it } from "vitest";

import { classifyCall } from "../src/engine/approval/rules.ts";
import type { ToolApprovalKind } from "../src/engine/tools/executor.ts";

const WS = "D:/proj";

/** 工具目录由 ToolDefinition.approval 自声明，测试直接给 kind。 */
function kindOf(name: string): ToolApprovalKind | undefined {
  const kinds: Record<string, ToolApprovalKind> = {
    read_file: "read",
    write_file: "write",
    edit_file: "write",
    run_command: "command",
  };
  return kinds[name];
}

function classify(name: string, args: Record<string, unknown>) {
  return classifyCall({ id: "1", name, args }, WS, kindOf(name));
}

describe("approval rules (classifyCall)", () => {
  describe("read-kind tools auto-allow", () => {
    it("read_file inside the workspace", () => {
      expect(classify("read_file", { path: "src/a.ts" })).toBe("allow");
    });
  });

  describe("command-kind safe patterns auto-allow", () => {
    it.each(["ls", "ls -la", "dir", "git status", "git log --oneline", "git diff HEAD~1", "npm test", "npm run build", "cat README.md", "pwd", "echo hi"])(
      "allow: %s",
      (command) => {
        expect(classify("run_command", { command })).toBe("allow");
      },
    );
  });

  describe("dangerous patterns are denied outright", () => {
    it.each([
      "rm -rf /",
      "rm -fr node_modules",
      "git push origin master",
      "git push --force",
      "sudo apt install x",
      "mkfs.ext4 /dev/sda",
      "del /f /q secret.txt",
      "format C:",
    ])("deny: %s", (command) => {
      expect(classify("run_command", { command })).toBe("deny");
    });
  });

  describe("writes outside the workspace are denied", () => {
    it("write_file with absolute path outside workspace", () => {
      const outside = process.platform === "win32" ? "C:/Windows/x.txt" : "/etc/x.txt";
      expect(classify("write_file", { path: outside })).toBe("deny");
    });

    it("write_file escaping via ..", () => {
      expect(classify("write_file", { path: "../outside.txt" })).toBe("deny");
    });

    it("write_file inside workspace is confirm (not auto-allow)", () => {
      expect(classify("write_file", { path: "src/new.ts" })).toBe("confirm");
    });

    it("any write-kind tool gets the same path guard (classification, not name)", () => {
      expect(classify("edit_file", { path: "../outside.ts" })).toBe("deny");
      expect(classify("edit_file", { path: "src/a.ts" })).toBe("confirm");
    });
  });

  describe("everything else asks once", () => {
    it.each([
      { name: "run_command", args: { command: "node build.js" } },
      { name: "run_command", args: { command: "npm install" } },
      { name: "unknown_tool", args: {} },
    ])("confirm: $name $args", ({ name, args }) => {
      expect(classify(name, args)).toBe("confirm");
    });
  });
});
