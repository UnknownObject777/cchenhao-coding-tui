/**
 * 本地配置加载（#38，#9 决策）：
 * 用户级 ~/.mini-agent/config.json + 项目级 <workspace>/.agent.json，
 * 优先级 env > 项目级 > 用户级；逐字段记录生效来源（脱敏，不记值）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface AgentConfigFile {
  /** provider 名："kimi"（默认）｜"openai"｜任意 OpenAI 兼容端点名（需显式 base_url/model）。 */
  provider?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  system_prompt_file?: string;
  /** 上下文 token 预算覆盖（#57）；缺省 CONTEXT_TOKEN_BUDGET（256K）。非正数/非数字忽略。 */
  context_budget?: number;
}

export interface EffectiveConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 解析成绝对路径的 system prompt 文件（#39）。 */
  systemPromptFile?: string;
  /** 上下文 token 预算覆盖（#57）；未配置时 loop 用 CONTEXT_TOKEN_BUDGET 缺省。 */
  contextBudget?: number;
  /** 字段 → 来源描述（如 "env:KIMI_MODEL"、"project:.agent.json"、"user:config.json"）。 */
  sources: Record<string, string>;
}

/** 每字段的 env 键表：KIMI_*（向后兼容）优先，OPENAI_* 作为通用别名兜底。 */
const ENV_KEYS: Record<string, [string, string]> = {
  apiKey: ["KIMI_API_KEY", "OPENAI_API_KEY"],
  baseUrl: ["KIMI_BASE_URL", "OPENAI_BASE_URL"],
  model: ["KIMI_MODEL", "OPENAI_MODEL"],
};

async function readConfigFile(path: string): Promise<AgentConfigFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined; // 文件不存在＝没配置，静默
  }
  try {
    return JSON.parse(raw) as AgentConfigFile;
  } catch (error) {
    // 写坏的配置不能静默吞掉——用户会误以为已生效
    process.stderr.write(`[config] 警告：${path} 解析失败（${error instanceof Error ? error.message : String(error)}），已忽略\n`);
    return undefined;
  }
}

export async function loadEffectiveConfig(workspace: string, home: string = homedir()): Promise<EffectiveConfig> {
  const userPath = join(home, ".mini-agent", "config.json");
  const projectPath = join(workspace, ".agent.json");

  const result: EffectiveConfig = { sources: {} };

  // 低 → 高 依次覆盖：用户级 → 项目级 → env
  const layers: Array<{ file: AgentConfigFile | undefined; label: string; baseDir: string }> = [
    { file: await readConfigFile(userPath), label: "user:config.json", baseDir: dirname(userPath) },
    { file: await readConfigFile(projectPath), label: "project:.agent.json", baseDir: workspace },
  ];
  for (const { file, label, baseDir } of layers) {
    if (file === undefined) continue;
    if (file.provider !== undefined) {
      result.provider = file.provider;
      result.sources["provider"] = label;
    }
    if (file.api_key !== undefined) {
      result.apiKey = file.api_key;
      result.sources["apiKey"] = label;
    }
    if (file.base_url !== undefined) {
      result.baseUrl = file.base_url;
      result.sources["baseUrl"] = label;
    }
    if (file.model !== undefined) {
      result.model = file.model;
      result.sources["model"] = label;
    }
    if (file.system_prompt_file !== undefined) {
      result.systemPromptFile = isAbsolute(file.system_prompt_file)
        ? file.system_prompt_file
        : resolve(baseDir, file.system_prompt_file);
      result.sources["systemPromptFile"] = label;
    }
    if (typeof file.context_budget === "number" && Number.isFinite(file.context_budget) && file.context_budget > 0) {
      result.contextBudget = file.context_budget;
      result.sources["contextBudget"] = label;
    }
  }

  for (const [field, envNames] of Object.entries(ENV_KEYS)) {
    for (const envName of envNames) {
      const value = process.env[envName];
      if (value === undefined || value === "") continue;
      (result as unknown as Record<string, string>)[field] = value;
      result.sources[field] = `env:${envName}`;
      // 命中 OPENAI_* 且未显式配置 provider → 推断为 openai（否则默认 kimi）
      if (result.provider === undefined && envName.startsWith("OPENAI_")) {
        result.provider = "openai";
        result.sources["provider"] = "env:OPENAI_*（推断）";
      }
      break;
    }
  }
  return result;
}

/**
 * 系统 prompt 解析（#39）：显式 system_prompt_file > 项目级 .agent.md > 内置默认。
 * 显式文件读不到＝大声失败（用户点名了的文件）；.agent.md 探查静默。
 */
export async function resolveSystemPrompt(
  config: EffectiveConfig,
  workspace: string,
  builtinDefault: string,
): Promise<{ prompt: string; source: string }> {
  if (config.systemPromptFile !== undefined) {
    try {
      return { prompt: await readFile(config.systemPromptFile, "utf8"), source: config.systemPromptFile };
    } catch (error) {
      throw new Error(
        `system_prompt_file 指向的文件读不到：${config.systemPromptFile}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  const agentMd = join(workspace, ".agent.md");
  try {
    return { prompt: await readFile(agentMd, "utf8"), source: agentMd };
  } catch {
    return { prompt: builtinDefault, source: "builtin default" };
  }
}

/** 生效来源的脱敏打印（stderr；只打字段与来源，不打值）。 */
export function describeConfigSources(config: EffectiveConfig, apiKeyFallback: string): string {
  const fields: Array<keyof EffectiveConfig & string> = [
    "provider",
    "apiKey",
    "baseUrl",
    "model",
    "systemPromptFile",
    "contextBudget",
  ];
  return fields
    .map((field) => {
      const source =
        config.sources[field] ?? (field === "apiKey" ? apiKeyFallback : field === "systemPromptFile" ? undefined : "default");
      return source === undefined ? undefined : `  ${field} ← ${source}`;
    })
    .filter((line) => line !== undefined)
    .join("\n");
}
