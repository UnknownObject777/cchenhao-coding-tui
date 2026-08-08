/**
 * 本地配置加载（#38，#9 决策）：
 * 用户级 ~/.mini-agent/config.json + 项目级 <workspace>/.agent.json，
 * 优先级 env > 项目级 > 用户级；逐字段记录生效来源（脱敏，不记值）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface AgentConfigFile {
  api_key?: string;
  base_url?: string;
  model?: string;
  system_prompt_file?: string;
}

export interface EffectiveConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 解析成绝对路径的 system prompt 文件（#39）。 */
  systemPromptFile?: string;
  /** 字段 → 来源描述（如 "env:KIMI_MODEL"、"project:.agent.json"、"user:config.json"）。 */
  sources: Record<string, string>;
}

const ENV_KEYS: Record<string, string> = {
  apiKey: "KIMI_API_KEY",
  baseUrl: "KIMI_BASE_URL",
  model: "KIMI_MODEL",
};

async function readConfigFile(path: string): Promise<AgentConfigFile | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgentConfigFile;
  } catch {
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
  }

  for (const [field, envName] of Object.entries(ENV_KEYS)) {
    const value = process.env[envName];
    if (value !== undefined && value !== "") {
      (result as unknown as Record<string, string>)[field] = value;
      result.sources[field] = `env:${envName}`;
    }
  }
  return result;
}

/** 生效来源的脱敏打印（stderr；只打字段与来源，不打值）。 */
export function describeConfigSources(config: EffectiveConfig, apiKeyFallback: string): string {
  const lines = Object.entries(config.sources).map(([field, source]) => `  ${field} ← ${source}`);
  if (config.sources["apiKey"] === undefined) {
    lines.push(`  apiKey ← ${apiKeyFallback}`);
  }
  return lines.join("\n");
}
