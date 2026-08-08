import { describe, expect, it } from "vitest";

import { classifyCall } from "../src/engine/approval/rules.ts";

const WS = "D:/proj";

describe("approval rules (classifyCall)", () => {
  describe("read-only tools auto-allow", () => {
    it("read_file inside the workspace", () => {
      expect(classifyCall({ id: "1", name: "read_file", args: { path: "src/a.ts" } }, WS)).toBe("allow");
    });
  });

  describe("run_command safe patterns auto-allow", () => {
    it.each(["ls", "ls -la", "dir", "git status", "git log --oneline", "git diff HEAD~1", "npm test", "npm run build", "cat README.md", "pwd", "echo hi"])(
      "allow: %s",
      (command) => {
        expect(classifyCall({ id: "1", name: "run_command", args: { command } }, WS)).toBe("allow");
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
      expect(classifyCall({ id: "1", name: "run_command", args: { command } }, WS)).toBe("deny");
    });
  });

  describe("writes outside the workspace are denied", () => {
    it("write_file with absolute path outside workspace", () => {
      const outside = process.platform === "win32" ? "C:/Windows/x.txt" : "/etc/x.txt";
      expect(classifyCall({ id: "1", name: "write_file", args: { path: outside } }, WS)).toBe("deny");
    });

    it("write_file escaping via ..", () => {
      expect(classifyCall({ id: "1", name: "write_file", args: { path: "../outside.txt" } }, WS)).toBe("deny");
    });

    it("write_file inside workspace is confirm (not auto-allow)", () => {
      expect(classifyCall({ id: "1", name: "write_file", args: { path: "src/new.ts" } }, WS)).toBe("confirm");
    });
  });

  describe("everything else asks once", () => {
    it.each([
      { name: "run_command", args: { command: "node build.js" } },
      { name: "run_command", args: { command: "npm install" } },
      { name: "unknown_tool", args: {} },
    ])("confirm: $name $args", ({ name, args }) => {
      expect(classifyCall({ id: "1", name, args }, WS)).toBe("confirm");
    });
  });
});
