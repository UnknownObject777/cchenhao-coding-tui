/**
 * skills 加载机制（#59）：SKILL.md 按需加载。
 * 发现：项目级 <workspace>/.agents/skills + 用户级 <home>/.mini-agent/skills，
 * 一层目录扫描（每 skill = 根下一个目录里的 SKILL.md）；重名时项目级覆盖用户级。
 * 启动只注入名称+描述清单；模型经 load_skill 工具 / 人经 /<skill-name> 触发加载全文。
 */
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../src/bootstrap.ts";
import { EventBus } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import { Loop } from "../src/engine/loop.ts";
import {
  discoverSkills,
  formatSkillInvocation,
  formatSkillList,
  parseSkillFrontmatter,
  registerSkillTool,
  type Skill,
} from "../src/engine/skills.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { buildSkillCommands } from "../src/tui/commands/skills.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

function skillMd(name: string, description: string, body = "skill body"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

interface SkillTestDirs {
  home: string;
  ws: string;
}

function setupDirs(): SkillTestDirs {
  return { home: makeTempDir("skills-home-"), ws: makeTempDir("skills-ws-") };
}

function cleanupDirs(dirs: SkillTestDirs): void {
  rmSync(dirs.home, { recursive: true, force: true });
  rmSync(dirs.ws, { recursive: true, force: true });
}

describe("parseSkillFrontmatter", () => {
  it("parses name/description and strips the frontmatter block from the body", () => {
    expect(parseSkillFrontmatter(skillMd("commit-style", "按仓库风格写提交信息"))).toEqual({
      name: "commit-style",
      description: "按仓库风格写提交信息",
      body: "skill body\n",
    });
  });

  it("strips single/double quotes so values may contain colons", () => {
    const parsed = parseSkillFrontmatter(
      `---\nname: "quoted-name"\ndescription: '带:冒号也能写'\n---\nx`,
    );
    expect(parsed).toEqual({ name: "quoted-name", description: "带:冒号也能写", body: "x" });
  });

  it("returns undefined when the file does not start with a frontmatter block", () => {
    expect(parseSkillFrontmatter("no frontmatter here")).toBeUndefined();
    expect(parseSkillFrontmatter("# heading\n\n---\nname: x\n---\n")).toBeUndefined();
  });

  it("returns undefined for an unterminated frontmatter block", () => {
    expect(parseSkillFrontmatter("---\nname: x\nno closing line")).toBeUndefined();
  });
});

describe("discoverSkills", () => {
  let dirs: SkillTestDirs;

  beforeEach(() => {
    dirs = setupDirs();
  });

  afterEach(() => {
    cleanupDirs(dirs);
  });

  it("returns an empty list when neither root exists", async () => {
    expect(await discoverSkills(dirs.ws, dirs.home)).toEqual([]);
  });

  it("finds project skills under <workspace>/.agents/skills", async () => {
    const skillPath = join(dirs.ws, ".agents", "skills", "commit-style", "SKILL.md");
    await mkdir(join(dirs.ws, ".agents", "skills", "commit-style"), { recursive: true });
    await writeFile(skillPath, skillMd("commit-style", "提交信息规范"));

    const skills = await discoverSkills(dirs.ws, dirs.home);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "commit-style",
      description: "提交信息规范",
      source: "project:.agents/skills",
      path: skillPath,
    });
  });

  it("finds user skills under <home>/.mini-agent/skills", async () => {
    await mkdir(join(dirs.home, ".mini-agent", "skills", "sop"), { recursive: true });
    await writeFile(join(dirs.home, ".mini-agent", "skills", "sop", "SKILL.md"), skillMd("sop", "通用操作流程"));

    const skills = await discoverSkills(dirs.ws, dirs.home);
    expect(skills[0]).toMatchObject({
      name: "sop",
      description: "通用操作流程",
      source: "user:~/.mini-agent/skills",
    });
  });

  it("project skills override user skills with the same name", async () => {
    await mkdir(join(dirs.home, ".mini-agent", "skills", "foo"), { recursive: true });
    await writeFile(join(dirs.home, ".mini-agent", "skills", "foo", "SKILL.md"), skillMd("foo", "user description"));
    await mkdir(join(dirs.ws, ".agents", "skills", "foo"), { recursive: true });
    await writeFile(join(dirs.ws, ".agents", "skills", "foo", "SKILL.md"), skillMd("foo", "project description"));

    const skills = await discoverSkills(dirs.ws, dirs.home);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe("project description");
    expect(skills[0]!.path).toContain(dirs.ws);
  });

  it("sorts the merged list by name", async () => {
    await mkdir(join(dirs.home, ".mini-agent", "skills", "beta"), { recursive: true });
    await writeFile(join(dirs.home, ".mini-agent", "skills", "beta", "SKILL.md"), skillMd("beta", "b"));
    await mkdir(join(dirs.home, ".mini-agent", "skills", "alpha"), { recursive: true });
    await writeFile(join(dirs.home, ".mini-agent", "skills", "alpha", "SKILL.md"), skillMd("alpha", "a"));
    await mkdir(join(dirs.ws, ".agents", "skills", "gamma"), { recursive: true });
    await writeFile(join(dirs.ws, ".agents", "skills", "gamma", "SKILL.md"), skillMd("gamma", "g"));

    expect((await discoverSkills(dirs.ws, dirs.home)).map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("skips directories without SKILL.md and non-directory entries", async () => {
    await mkdir(join(dirs.ws, ".agents", "skills", "nofile"), { recursive: true });
    await writeFile(join(dirs.ws, ".agents", "skills", "stray.md"), "not a skill dir");

    expect(await discoverSkills(dirs.ws, dirs.home)).toEqual([]);
  });

  it("skips SKILL.md with invalid frontmatter and keeps the valid ones", async () => {
    const root = join(dirs.ws, ".agents", "skills");
    const write = (dir: string, content: string) =>
      mkdir(join(root, dir), { recursive: true }).then(() => writeFile(join(root, dir, "SKILL.md"), content));
    await write("nofm", "plain markdown without frontmatter");
    await write("badcase", skillMd("CommitStyle", "大写非法"));
    await write("badunder", skillMd("commit_style", "下划线非法"));
    await write("noname", `---\ndescription: 没名字\n---\nx`);
    await write("nodesc", `---\nname: nodesc\n---\nx`);
    await write("longname", skillMd("a".repeat(65), "名字超长"));
    await write("longdesc", skillMd("longdesc", "d".repeat(1025)));
    await write("good", skillMd("good", "唯一合法"));

    const skills = await discoverSkills(dirs.ws, dirs.home);
    expect(skills.map((s) => s.name)).toEqual(["good"]);
  });

  it("only scans one directory level (nested SKILL.md is not discovered)", async () => {
    await mkdir(join(dirs.ws, ".agents", "skills", "outer", "inner"), { recursive: true });
    await writeFile(join(dirs.ws, ".agents", "skills", "outer", "inner", "SKILL.md"), skillMd("nested", "nested"));

    expect(await discoverSkills(dirs.ws, dirs.home)).toEqual([]);
  });
});

describe("formatSkillList", () => {
  it("returns an empty string when there are no skills", () => {
    expect(formatSkillList([])).toBe("");
  });

  it("lists each skill's name and description plus the load_skill hint", () => {
    const skills: Skill[] = [
      { name: "commit-style", description: "提交信息规范", path: "/x/SKILL.md", source: "project:.agents/skills" },
      { name: "sop", description: "通用流程", path: "/y/SKILL.md", source: "user:~/.mini-agent/skills" },
    ];
    const text = formatSkillList(skills);
    expect(text).toContain("## Skills");
    expect(text).toContain("- commit-style: 提交信息规范");
    expect(text).toContain("- sop: 通用流程");
    expect(text).toContain("load_skill");
  });
});

describe("load_skill tool", () => {
  let dirs: SkillTestDirs;
  let executor: ToolExecutor;
  let skills: Skill[];

  beforeEach(async () => {
    dirs = setupDirs();
    await mkdir(join(dirs.ws, ".agents", "skills", "commit-style"), { recursive: true });
    await writeFile(
      join(dirs.ws, ".agents", "skills", "commit-style", "SKILL.md"),
      skillMd("commit-style", "提交信息规范", "body text"),
    );
    skills = await discoverSkills(dirs.ws, dirs.home);
    executor = new ToolExecutor();
    registerSkillTool(executor, skills);
  });

  afterEach(() => {
    cleanupDirs(dirs);
  });

  it("is not registered when there are no skills (avoid a dead tool)", () => {
    const bare = new ToolExecutor();
    registerSkillTool(bare, []);
    expect(bare.definitions().map((t) => t.name)).not.toContain("load_skill");
  });

  it("is a read-class tool (no approval prompt, like read_file)", () => {
    expect(executor.approvalKind("load_skill")).toBe("read");
  });

  it("returns the full SKILL.md body wrapped in a skill invocation, frontmatter stripped", async () => {
    const result = await executor.execute("load_skill", { name: "commit-style" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('<skill name="commit-style"');
    expect(result.output).toContain("body text");
    expect(result.output).not.toContain("description:");
  });

  it("fails with the available names for an unknown skill", async () => {
    const result = await executor.execute("load_skill", { name: "nope" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unknown skill: nope");
    expect(result.output).toContain("commit-style");
  });
});

describe("loop context injection", () => {
  it("injected content lands as a user message visible to the next request", async () => {
    const llm = new FakeLLM([[{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }]]);
    const loop = new Loop({ llm, executor: new ToolExecutor(), bus: new EventBus(), systemPrompt: "sys" });

    loop.injectContext(formatSkillInvocation("commit-style", "/x/SKILL.md", "body text"));
    await loop.runTurn("按 skill 来");

    const firstRequest = llm.requests[0]!;
    expect(firstRequest[1]).toEqual({
      role: "user",
      content: '<skill name="commit-style" path="/x/SKILL.md">\nbody text\n</skill>',
    });
    expect(firstRequest[2]).toEqual({ role: "user", content: "按 skill 来" });
  });
});

describe("buildSkillCommands", () => {
  it("produces one command per skill that triggers invokeSkill with the skill name", async () => {
    const invokeSkill = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
    const skills: Skill[] = [
      { name: "commit-style", description: "提交信息规范", path: "/x/SKILL.md", source: "project:.agents/skills" },
    ];
    const commands = buildSkillCommands(skills);
    expect(commands.map((c) => c.name)).toEqual(["commit-style"]);
    await commands[0]!.execute({ invokeSkill } as never);
    expect(invokeSkill).toHaveBeenCalledWith("commit-style");
  });
});

describe("bootstrap wiring (#59)", () => {
  it("discovers skills, appends the list to the system prompt, registers load_skill", async () => {
    const dirs = setupDirs();
    try {
      await mkdir(join(dirs.ws, ".agents", "skills", "commit-style"), { recursive: true });
      await writeFile(
        join(dirs.ws, ".agents", "skills", "commit-style", "SKILL.md"),
        skillMd("commit-style", "提交信息规范"),
      );
      const agent = await bootstrap({ workspace: dirs.ws, fake: true, sessionRoot: dirs.ws, homeDir: dirs.home });

      expect(agent.skills).toHaveLength(1);
      expect(agent.skills[0]!.name).toBe("commit-style");
      expect(agent.systemPrompt).toContain("## Skills");
      expect(agent.systemPrompt).toContain("- commit-style: 提交信息规范");
      expect(agent.approvalKind("load_skill")).toBe("read");
    } finally {
      cleanupDirs(dirs);
    }
  });

  it("leaves the system prompt untouched and registers no load_skill when no skills exist", async () => {
    const dirs = setupDirs();
    try {
      const agent = await bootstrap({ workspace: dirs.ws, fake: true, sessionRoot: dirs.ws, homeDir: dirs.home });
      expect(agent.skills).toEqual([]);
      expect(agent.systemPrompt).not.toContain("## Skills");
      expect(agent.approvalKind("load_skill")).toBeUndefined();
    } finally {
      cleanupDirs(dirs);
    }
  });
});
