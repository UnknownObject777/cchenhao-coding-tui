/** skill slash 命令（#59）：每个发现的 skill 生成一条 /<skill-name>，人等价触发 load_skill 工具注入全文。 */
import type { Skill } from "../../engine/skills.ts";
import type { SlashCommandDefinition } from "./types.ts";

export function buildSkillCommands(skills: Skill[]): SlashCommandDefinition[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: `加载 skill「${skill.name}」全文到上下文（等价 load_skill 工具）`,
    execute: (ctx) => ctx.invokeSkill(skill.name),
  }));
}
