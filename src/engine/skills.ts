/**
 * skills 加载机制（#59，决策见 issue #59）：SKILL.md 按需加载。
 * 发现：项目级 <workspace>/.agents/skills + 用户级 <home>/.mini-agent/skills，
 * 一层目录扫描（每 skill = 根下一个目录里的 SKILL.md，不递归）；重名时项目级覆盖用户级；
 * 同根内重名按 (name, path) 排序后取路径最大者——确定性，不受 readdir 目录项顺序影响。
 * 启动只注入名称+描述清单（formatSkillList），模型经 load_skill 工具 / 人经 /<skill-name> 触发加载全文。
 * 不做 .gitignore 感知、不做 SkillDiagnostic 细粒度诊断（无效文件静默跳过）。
 * 上游（pi-mono loadSkills）可借鉴点：frontmatter 校验（name ≤64 小写 a-z/数字/连字符、description ≤1024）、多来源 merge；不 vendor。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutor } from "./tools/executor.ts";

export interface Skill {
  /** frontmatter 的 name（≤64，^[a-z0-9-]+$）；工具参数与 slash 都按它匹配。 */
  name: string;
  /** frontmatter 的 description（≤1024，非空）。 */
  description: string;
  /** SKILL.md 绝对路径（读取全文用）。 */
  path: string;
  /** 来源标签：project:.agents/skills ｜ user:~/.mini-agent/skills。 */
  source: string;
}

/** 一层扫描（每 skill = 根下一个目录里的 SKILL.md）；目录缺失静默返回空。 */
async function scanSkillsDir(root: string, sourceLabel: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // 非目录条目（散落的 .md）不算 skill
    const path = join(root, entry.name, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue; // 目录里没有 SKILL.md → 跳过
    }
    const parsed = parseSkillFrontmatter(raw);
    if (parsed === undefined || !isValidSkill(parsed)) continue;
    skills.push({ name: parsed.name, description: parsed.description, path, source: sourceLabel });
  }
  // 同根内按 (name, path) 排序后去重：重名只留排序后最后者——消除 readdir 目录项顺序对结果的影响（确定性）
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const unique: Skill[] = [];
  for (const skill of skills) {
    if (unique.length > 0 && unique[unique.length - 1]!.name === skill.name) {
      unique[unique.length - 1] = skill;
    } else {
      unique.push(skill);
    }
  }
  return unique;
}

/**
 * 合并发现：用户级先入、项目级后入覆盖（重名时项目级优先），按 name 排序保证确定性。
 * home 与 workspace 的 homeDir 测试缝同源（bootstrap 的 homeDir）。
 */
export async function discoverSkills(workspace: string, home: string): Promise<Skill[]> {
  const userSkills = await scanSkillsDir(join(home, ".mini-agent", "skills"), "user:~/.mini-agent/skills");
  const projectSkills = await scanSkillsDir(join(workspace, ".agents", "skills"), "project:.agents/skills");
  const byName = new Map<string, Skill>();
  for (const skill of userSkills) byName.set(skill.name, skill);
  for (const skill of projectSkills) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const NAME_RE = /^[a-z0-9-]+$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

function isValidSkill(
  parsed: { name?: string; description?: string },
): parsed is { name: string; description: string } {
  const name = parsed.name;
  const description = parsed.description;
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= NAME_MAX &&
    NAME_RE.test(name) &&
    typeof description === "string" &&
    description.length > 0 &&
    description.length <= DESCRIPTION_MAX
  );
}

/** 剥掉值两侧的单/双引号（YAML 最简子集；不做多行折叠值）。 */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * 极简 YAML frontmatter 解析：文件头 `---` 起、`---` 收，逐行 `key: value`；
 * 只取 name/description，其余键忽略。无 frontmatter 或未闭合 → undefined。
 */
export function parseSkillFrontmatter(
  raw: string,
): { name?: string; description?: string; body: string } | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const fields: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === "") continue;
    fields[key] = stripQuotes(line.slice(colon + 1));
  }
  if (i >= lines.length) return undefined; // 未闭合 → 无效
  return { name: fields["name"], description: fields["description"], body: lines.slice(i + 1).join("\n").trimStart() };
}

/** 读 SKILL.md 全文并剥掉 frontmatter 块（防御：发现时必有 frontmatter，但容忍缺失）。 */
export async function skillBody(skill: Skill): Promise<string> {
  const parsed = parseSkillFrontmatter(await readFile(skill.path, "utf8"));
  return parsed?.body ?? "";
}

/** 回灌形状：load_skill 工具结果与 /<skill-name> 注入共用，保证模型看到同一形态。 */
export function formatSkillInvocation(name: string, path: string, body: string): string {
  return `<skill name="${name}" path="${path}">\n${body}\n</skill>`;
}

/** 清单注入形状：追加到生效系统 prompt 末尾；空列表返回 ""（不追加、不注册工具）。 */
export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "## Skills",
    "Skills are loaded on demand: each entry below is only a name and a short description. " +
      "Use the load_skill tool to fetch the full SKILL.md body before relying on a skill, " +
      "or ask the user to run /<skill-name> to inject it into the conversation.",
    ...lines,
  ].join("\n");
}

/** load_skill 工具：读全文回灌（read 类，自动放行，与 read_file 同级）。无 skills 时不注册，避免必然失败的噪音工具。 */
export function registerSkillTool(executor: ToolExecutor, skills: Skill[]): void {
  if (skills.length === 0) return;
  executor.register({
    name: "load_skill",
    description:
      "Load the full instructions of a skill by name (see the skills list in the system prompt). " +
      "Returns the SKILL.md body wrapped in a <skill> block; follow its techniques when the task matches.",
    approval: "read",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name from the available skills list" } },
      required: ["name"],
    },
    execute: async (args) => {
      const name = String(args["name"] ?? "");
      const skill = skills.find((s) => s.name === name);
      if (skill === undefined) {
        throw new Error(`unknown skill: ${name}; available: ${skills.map((s) => s.name).join(", ")}`);
      }
      return formatSkillInvocation(skill.name, skill.path, await skillBody(skill));
    },
  });
}
