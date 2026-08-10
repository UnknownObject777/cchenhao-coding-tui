import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyCall } from "../src/engine/approval/rules.ts";
import type { ToolApprovalKind } from "../src/engine/tools/executor.ts";
import { classifyPathZone } from "../src/engine/zone.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

/**
 * 路径区判定（#74）：唯一入口 classifyPathZone 的单元测试。
 * 三类绕过（symlink / Windows 大小写 / gitdir 指针）+ 保护段无条件 deny 都在真实临时目录上验证。
 */
describe("path zone classification (#74)", () => {
  let zone: string;

  beforeEach(() => {
    zone = makeTempDir("zone-test-");
    mkdirSync(join(zone, "src"), { recursive: true });
    mkdirSync(join(zone, "sub", "deep"), { recursive: true });
    writeFileSync(join(zone, "src", "a.ts"), "x");
  });

  afterEach(() => {
    rmSync(zone, { recursive: true, force: true });
  });

  describe("inside / outside", () => {
    it("relative path under the zone root is inside", () => {
      expect(classifyPathZone(zone, "src/a.ts")).toBe("inside");
    });

    it("the zone root itself is inside", () => {
      expect(classifyPathZone(zone, ".")).toBe("inside");
      expect(classifyPathZone(zone, "")).toBe("inside");
    });

    it("'..' escape is outside", () => {
      expect(classifyPathZone(zone, "../outside.txt")).toBe("outside");
    });

    it("absolute path outside the zone is outside", () => {
      const outside = makeTempDir("zone-outside-");
      try {
        expect(classifyPathZone(zone, join(outside, "x.txt"))).toBe("outside");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("nonexistent path under the zone stays inside (write target)", () => {
      expect(classifyPathZone(zone, "sub/deep/new.ts")).toBe("inside");
      expect(classifyPathZone(zone, "brand-new-dir/file.md")).toBe("inside");
    });
  });

  describe("protected segments deny unconditionally, not via config (#74/#63)", () => {
    it.each([
      ".git",
      ".git/config",
      ".git/objects/ab/123",
      "sub/deep/.git/HEAD",
      "vendor/x/.git/config",
    ])("protected: %s", (path) => {
      expect(classifyPathZone(zone, path)).toBe("protected");
    });

    it("the .git segment name is matched case-insensitively", () => {
      expect(classifyPathZone(zone, ".GIT/HEAD")).toBe("protected");
      expect(classifyPathZone(zone, "sub/.Git/config")).toBe("protected");
    });

    it("the .gitignore basename is NOT protected (no over-broad match)", () => {
      expect(classifyPathZone(zone, ".gitignore")).toBe("inside");
      expect(classifyPathZone(zone, "src/.gitignore")).toBe("inside");
    });
  });

  describe.runIf(symlinksSupported())("symlink bypass (#74)", () => {
    let outside: string;
    beforeEach(() => {
      outside = makeTempDir("zone-symlink-out-");
    });
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it("symlink inside the zone pointing outside → outside", () => {
      symlinkSync(join(outside, "target"), join(zone, "link-out"), "file");
      writeFileSync(join(outside, "target"), "outside");
      expect(classifyPathZone(zone, "link-out")).toBe("outside");
      expect(classifyPathZone(zone, join(zone, "link-out"))).toBe("outside");
    });

    it("symlink inside the zone pointing into .git → protected", () => {
      mkdirSync(join(zone, ".git"), { recursive: true }); // 目标存在 → 走 realpath 判定
      symlinkSync(join(zone, ".git", "config"), join(zone, "link-git"), "file");
      expect(classifyPathZone(zone, "link-git")).toBe("protected");
    });

    it("dangling symlink pointing into .git → protected (write would land in .git)", () => {
      // 目标不存在：realpath 解析不到，但写会穿到 zone/.git/config
      symlinkSync(join(zone, ".git", "config"), join(zone, "link-git-dangling"), "file");
      expect(classifyPathZone(zone, "link-git-dangling")).toBe("protected");
    });

    it("dangling symlink pointing outside → outside", () => {
      symlinkSync(join(outside, "nope"), join(zone, "link-out-dangling"), "file");
      expect(classifyPathZone(zone, "link-out-dangling")).toBe("outside");
    });

    it("symlink inside the zone pointing at a sibling stays inside", () => {
      symlinkSync(join(zone, "src", "a.ts"), join(zone, "link-in"), "file");
      expect(classifyPathZone(zone, "link-in")).toBe("inside");
    });
  });

  describe.runIf(process.platform === "win32")("windows case-insensitivity (#74)", () => {
    it("an existing file queried with a different case stays inside", () => {
      writeFileSync(join(zone, "File.txt"), "x");
      expect(classifyPathZone(zone, "file.txt")).toBe("inside");
      expect(classifyPathZone(zone, join(zone, "FILE.TXT"))).toBe("inside");
    });

    it("the zone root itself queried with a different case stays inside", () => {
      const cased = zone.replace(/^([A-Za-z]):/, (m) => m.toLowerCase()).toUpperCase();
      expect(classifyPathZone(cased, "src/a.ts")).toBe("inside");
    });
  });

  describe.runIf(process.platform === "win32")("windows junction bypass (#74)", () => {
    // junction 是 Windows 上免提权的目录链接（symlink 需开发者模式/管理员），realpath 同样解析到真实目标
    let outside: string;
    beforeEach(() => {
      outside = makeTempDir("zone-junction-out-");
      mkdirSync(join(outside, "real-dir"), { recursive: true });
      mkdirSync(join(zone, "inside-dir"), { recursive: true });
      writeFileSync(join(outside, "real-dir", "x"), "outside");
      writeFileSync(join(zone, "inside-dir", "y"), "inside");
      symlinkSync(join(outside, "real-dir"), join(zone, "junc-out"), "junction");
      symlinkSync(join(zone, "inside-dir"), join(zone, "junc-in"), "junction");
    });
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it("junction pointing outside resolves to outside", () => {
      expect(classifyPathZone(zone, "junc-out/x")).toBe("outside");
    });

    it("junction pointing inside the zone stays inside", () => {
      expect(classifyPathZone(zone, "junc-in/y")).toBe("inside");
    });
  });

  describe("gitdir: pointer file (worktree layout) (#74)", () => {
    let main: string;
    let gitDir: string;
    beforeEach(() => {
      // worktree 形态：zone 的 .git 是指针文件，指向主仓库的真实 git 目录
      main = makeTempDir("zone-main-");
      gitDir = join(main, ".git", "worktrees", "wt");
      writeFileSync(join(zone, ".git"), `gitdir: ${gitDir}\n`);
    });
    afterEach(() => {
      rmSync(main, { recursive: true, force: true });
    });

    it("the .git pointer file itself is protected", () => {
      expect(classifyPathZone(zone, ".git")).toBe("protected");
    });

    it("anything spelled through the .git segment is protected", () => {
      expect(classifyPathZone(zone, ".git/HEAD")).toBe("protected");
      expect(classifyPathZone(zone, ".git/objects/ab/123")).toBe("protected");
    });

    it("the real git dir behind the pointer is protected even though it lives outside the zone", () => {
      // 词法上在区外（主仓库 .git 下），但经 gitdir 指针确认为 git 元数据 → 无条件 deny
      expect(classifyPathZone(zone, join(gitDir, "HEAD"))).toBe("protected");
      expect(classifyPathZone(zone, join(gitDir))).toBe("protected");
    });

    it("regular files in the worktree stay inside", () => {
      expect(classifyPathZone(zone, "src/a.ts")).toBe("inside");
    });

    it("the pointer target is also protected when the zone is the main repo", () => {
      expect(classifyPathZone(main, join(gitDir, "HEAD"))).toBe("protected");
    });
  });

  describe("approval rules use the same entry (#74)", () => {
    const kindOf = (name: string): ToolApprovalKind | undefined =>
      ({ read_file: "read", write_file: "write", edit_file: "write", run_command: "command" })[name] as
        | ToolApprovalKind
        | undefined;
    const classify = (name: string, args: Record<string, unknown>) =>
      classifyCall({ id: "1", name, args }, zone, kindOf(name));

    it("write_file to the .git pointer file is denied", () => {
      writeFileSync(join(zone, ".git"), "gitdir: somewhere\n");
      expect(classify("write_file", { path: ".git" })).toBe("deny");
      expect(classify("edit_file", { path: ".git/HEAD" })).toBe("deny");
    });

    it("write_file to a case-variant protected path is denied", () => {
      expect(classify("write_file", { path: ".GIT/HEAD" })).toBe("deny");
    });

    it("write_file to a nonexistent inside path stays confirm", () => {
      expect(classify("write_file", { path: "sub/deep/new.ts" })).toBe("confirm");
    });

    describe.runIf(symlinksSupported())("through symlinks", () => {
      let outside: string;
      beforeEach(() => {
        outside = makeTempDir("zone-approval-out-");
      });
      afterEach(() => {
        rmSync(outside, { recursive: true, force: true });
      });

      it("write_file through a symlink to outside is denied", () => {
        symlinkSync(join(outside, "target"), join(zone, "link-out"), "file");
        expect(classify("write_file", { path: "link-out" })).toBe("deny");
      });

      it("write_file through a symlink to inside stays confirm", () => {
        symlinkSync(join(zone, "src", "a.ts"), join(zone, "link-in"), "file");
        expect(classify("write_file", { path: "link-in" })).toBe("confirm");
      });
    });
  });
});

/** Windows 上建 symlink 需要管理员/开发者模式，探测失败则整组跳过（CI runner 常见）。 */
function symlinksSupported(): boolean {
  try {
    const dir = makeTempDir("zone-symlink-probe-");
    try {
      writeFileSync(join(dir, "target"), "x");
      symlinkSync(join(dir, "target"), join(dir, "link"), "file");
      return true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}
