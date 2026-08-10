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

  describe("protected paths are denied even inside the workspace (#63)", () => {
    it.each([
      { name: "write_file", args: { path: ".git/config" } },
      { name: "write_file", args: { path: ".git/objects/ab/123" } },
      { name: "edit_file", args: { path: ".git/HEAD" } },
      { name: "edit_file", args: { path: ".git/info/exclude" } },
    ])("deny: $name $args", ({ name, args }) => {
      expect(classify(name, args)).toBe("deny");
    });

    it("the .gitignore basename is NOT treated as inside .git/ (no over-broad match)", () => {
      expect(classify("write_file", { path: ".gitignore" })).toBe("confirm");
    });

    it("denies nested .git paths, not only the top-level .git (#63)", () => {
      expect(classify("write_file", { path: "vendor/x/.git/config" })).toBe("deny");
      expect(classify("edit_file", { path: "sub/deep/.git/HEAD" })).toBe("deny");
      expect(classify("write_file", { path: "sub/.git/config" })).toBe("deny");
    });

    it("non-protected writes inside the workspace stay confirm", () => {
      expect(classify("write_file", { path: "src/a.ts" })).toBe("confirm");
    });
  });

  describe("git ops that write or destroy repo state are denied (#63)", () => {
    it.each([
      "git config user.name mini",
      "git reset --hard HEAD~1",
      "git reset HEAD~1",
      "git clean -fd",
      "git checkout .",
      "git checkout -- src/a.ts",
    ])("deny: %s", (command) => {
      expect(classify("run_command", { command })).toBe("deny");
    });

    it("read-only git ops stay auto-allowed", () => {
      expect(classify("run_command", { command: "git status" })).toBe("allow");
      expect(classify("run_command", { command: "git diff HEAD~1" })).toBe("allow");
    });

    it("branch checkout (non-destructive) still asks once", () => {
      expect(classify("run_command", { command: "git checkout dev" })).toBe("confirm");
    });
  });

  describe("command escape intent is never auto-allowed (#75)", () => {
    // 静态判定只是启发式（#71：8/15 subagent 绕过实证）：目标「可见+必批」——命中出区意图即确认，不追求不可绕过
    const outsideAbs = process.platform === "win32" ? "C:\\Windows\\System32\\x.txt" : "/etc/passwd";
    const homeRef = process.platform === "win32" ? "%USERPROFILE%\\x" : "~/x";

    it.each([
      // cd 逃逸：相对 .. 上溯出区根
      "cd ..",
      "cd ../..",
      "cd ../../x",
      "cd .. && npm test",
      "cd ..\\..\\x",
      "pushd ..",
      // 绝对路径指向区外
      `cd ${outsideAbs}`,
      `cat ${outsideAbs}`,
      `ls ${outsideAbs}`,
      `cat ${outsideAbs} 2>/dev/null`,
      // .. 出现在普通参数里（cat ../secret 走的是 ^cat 安全 pattern，命中出区必须压过 allow）
      "ls ..",
      "cat ../secret.txt",
      "cat ../../src/x",
      "git status ..",
      "pwd && cd ..",
      // 家目录引用（~、$HOME、%USERPROFILE%）在区外
      "cd ~",
      "cd ~/x",
      `cat ${homeRef}`,
      "cd $HOME",
      "echo $HOME/.ssh/id_rsa",
      // 旗标携带区外路径
      "npm run build -- --outDir=../dist",
      "mkdir -p ../build",
    ])("confirm (out-of-zone, must-approve): %s", (command) => {
      expect(classify("run_command", { command })).toBe("confirm");
    });

    it("escape intent combined with a dangerous pattern still denies", () => {
      expect(classify("run_command", { command: "rm -rf ../node_modules" })).toBe("deny");
      expect(classify("run_command", { command: "git push && cd .." })).toBe("deny");
    });

    it("in-zone commands stay auto-allowed (#75 不误伤)", () => {
      expect(classify("run_command", { command: "ls ." })).toBe("allow");
      expect(classify("run_command", { command: "cat ./README.md" })).toBe("allow");
      expect(classify("run_command", { command: "git log HEAD..HEAD~1" })).toBe("allow");
      expect(classify("run_command", { command: "ls src/a.ts" })).toBe("allow");
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
