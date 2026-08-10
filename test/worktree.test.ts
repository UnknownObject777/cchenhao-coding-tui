/**
 * #86 worktree 创建与分支绑定：自进化会话在 worktrees/<slug> 创建独立 worktree + 独立分支，
 * 会话全程绑定该根。验收三条：创建与进入可演示、会话内默认路径解析到 worktree 根、并发创建不踩 git 锁。
 * 回收（拆除/收割）属 #88，不在本票范围。
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { canonicalZoneRoot, classifyPathZone } from "../src/engine/zone.ts";
import { ensureWorktree, listWorktrees, worktreeSlug } from "../src/engine/worktree.ts";

describe("worktree creation (#86)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("worktree-test-");
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "v1\n", "utf8");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function git(...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  }

  it("creates worktrees/<slug> on an independent branch and registers it", async () => {
    const info = await ensureWorktree(dir, "demo-1");

    expect(info.relativePath).toBe("worktrees/demo-1");
    expect(info.branch).toBe("cage-demo-1");
    // 根是 canonical 绝对路径（与 #74 区判定同一形态；Windows junction/大小写经 realpath 归一）
    expect(info.root).toBe(canonicalZoneRoot(join(dir, "worktrees", "demo-1")));
    // HEAD（master 的提交）被检出进 worktree
    expect(existsSync(join(info.root, "a.txt"))).toBe(true);
    // 独立分支：worktree 内 HEAD 指向 cage-<slug>，主工作树仍在 master
    const branch = execFileSync("git", ["-C", info.root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(branch).toBe("cage-demo-1");
    const mainBranch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    expect(mainBranch).toBe("master");
    // 注册表可解析（git worktree list --porcelain，不另存状态）
    const listed = await listWorktrees(dir);
    expect(listed.some((w) => w.relativePath === "worktrees/demo-1" && w.branch === "cage-demo-1")).toBe(true);
    // 区判定唯一入口对 worktree 根照常工作（会话内默认路径解析到该根）
    expect(classifyPathZone(info.root, "src/new.ts")).toBe("inside");
  });

  it("is idempotent: same slug reuses the existing worktree", async () => {
    const first = await ensureWorktree(dir, "demo-2");
    const second = await ensureWorktree(dir, "demo-2");

    expect(second.root).toBe(first.root);
    expect(second.branch).toBe(first.branch);
    const matching = (await listWorktrees(dir)).filter((w) => w.relativePath === "worktrees/demo-2");
    expect(matching).toHaveLength(1);
  });

  it("concurrent creation of distinct slugs all succeed without clashing", async () => {
    const slugs = Array.from({ length: 6 }, (_, i) => `parallel-${i}`);
    const results = await Promise.all(slugs.map((slug) => ensureWorktree(dir, slug)));

    for (const [i, info] of results.entries()) {
      expect(info.branch).toBe(`cage-${slugs[i]}`);
      expect(existsSync(join(info.root, "a.txt"))).toBe(true);
    }
    const listed = await listWorktrees(dir);
    expect(listed.filter((w) => w.relativePath.startsWith("worktrees/parallel-"))).toHaveLength(slugs.length);
  });

  it("concurrent creation of the same slug yields a single worktree (no git lock clash)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureWorktree(dir, "same-slug")));

    expect(new Set(results.map((r) => r.root)).size).toBe(1);
    const matching = (await listWorktrees(dir)).filter((w) => w.relativePath === "worktrees/same-slug");
    expect(matching).toHaveLength(1);
  });

  it("fails loudly outside a git repository", async () => {
    const plain = makeTempDir("worktree-nogit-");
    try {
      await expect(ensureWorktree(plain, "x")).rejects.toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("slug is filesystem- and branch-name-safe", () => {
    const slug = worktreeSlug();
    expect(slug).toMatch(/^[\w-]+$/);
    expect(slug.length).toBeGreaterThan(10);
    expect(`${"cage-" + slug}`).toMatch(/^[a-zA-Z0-9-]+$/); // git refname 安全字符
  });
});

describe("session binds the worktree root (#86)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("worktree-bind-");
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.name", "test"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
    writeFileSync(join(dir, "a.txt"), "v1\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "a.txt"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("bootstrap with worktree:true creates a worktree and resolves all session paths to its root", async () => {
    const agent = await bootstrap({
      workspace: dir,
      fake: true,
      worktree: true,
      sessionRoot: dir,
      printApproval: { yes: true },
    });

    // 会话根 = worktree 根（不是主仓库）
    expect(agent.worktree).toBeDefined();
    expect(agent.workspace).toBe(agent.worktree!.root);
    expect(agent.workspace).not.toBe(dir);
    expect(agent.workspace.startsWith(join(dir, "worktrees"))).toBe(true);

    // 会话内默认路径解析到 worktree 根：工具写文件落 worktree，主工作区不被触碰
    await agent.loop.runTurn("写个 hello 文件");
    expect(existsSync(join(agent.workspace, "hello.txt"))).toBe(true);
    expect(existsSync(join(dir, "hello.txt"))).toBe(false);
  });

  it("worktree stays off without the flag (main workspace untouched)", async () => {
    const agent = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir });

    expect(agent.worktree).toBeUndefined();
    expect(agent.workspace).toBe(dir);
    expect(existsSync(join(dir, "worktrees"))).toBe(false);
  });

  it("cage mode: in-zone writes auto-allow even without --yes (#87 区内放行零打扰)", async () => {
    const agent = await bootstrap({
      workspace: dir,
      fake: true,
      worktree: true,
      sessionRoot: dir,
      printApproval: { yes: false },
    });
    await agent.loop.runTurn("demo");

    // 无 --yes（应答源拒绝一切 confirm）时区内写仍自动放行落盘；主工作区不被触碰
    expect(existsSync(join(agent.workspace, "hello.txt"))).toBe(true);
    expect(existsSync(join(dir, "hello.txt"))).toBe(false);
  });
});
