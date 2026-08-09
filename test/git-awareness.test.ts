/**
 * #62 git 感知：会话开始时探测工作区 git 脏状态。
 * 只读探测（git status --porcelain），不做任何 git 写操作；
 * 非 git 仓库 / git 不可用 / 超时一律静默返回 undefined。
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectGitDirty } from "../src/engine/git.ts";

describe("git awareness (#62)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("git-aware-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 在临时工作区里跑 git 建仓（测试需要真仓才能得到 status 输出）。 */
  function git(...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  }

  it("returns undefined outside a git repository", async () => {
    expect(await detectGitDirty(dir)).toBeUndefined();
  });

  it("returns undefined for a clean working tree", async () => {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "v1\n", "utf8");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    expect(await detectGitDirty(dir)).toBeUndefined();
  });

  it("counts modified and untracked files as dirty", async () => {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "v1\n", "utf8");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "a.txt"), "v2\n", "utf8"); // 已跟踪文件被改
    writeFileSync(join(dir, "new.txt"), "x\n", "utf8"); // 未跟踪文件
    expect(await detectGitDirty(dir)).toEqual({ count: 2 });
  });
});
