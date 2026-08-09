/**
 * LLM provider 薄工厂（#55，轻量路线，spec-v2:9）：
 * 引擎侧只认 LLMRequester 接口（types.ts），本模块按配置选 requester 并完成凭证合并
 * （env + 双级配置已在 config.ts 合并）与 kimi 订阅 OAuth 兜底。
 * 不引入重抽象：所有 provider 走同一个 OpenAICompatibleLLM，仅默认值/兜底/错误提示参数化。
 */
import { readKimiOAuthToken } from "./credentials.ts";
import { OpenAICompatibleLLM, type LLMCredentials } from "./openai-compatible.ts";
import type { LLMRequester } from "./types.ts";

export interface LLMFactoryConfig {
  /** provider 名："kimi"（默认）｜"openai"｜任意 OpenAI 兼容端点名（需显式 base_url/model）。 */
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 测试缝：kimi 订阅凭证文件的 home 根目录（默认 os.homedir()）。 */
  homeDir?: string;
}

export interface BuiltLLM {
  llm: LLMRequester;
  /** 实际生效的 provider 名（含 env 推断值）。 */
  provider: string;
  /** 生效的模型名（UI 展示用）。 */
  model: string;
  /** web 工具复用凭证的显式出口（当前与 LLM 同一份凭证）。 */
  webCredentials: { apiKey: string; baseUrl: string };
}

interface ProviderDefaults {
  baseUrl: string;
  model: string;
  /** 401/403 时的可操作提示。 */
  authHint: string;
  /** kimi 专属：无显式 apiKey 时用订阅 OAuth 兜底。 */
  oauthFallback?: boolean;
}

const PROVIDERS: Record<string, ProviderDefaults> = {
  kimi: {
    baseUrl: "https://api.kimi.com/coding/v1",
    model: "kimi-for-coding",
    authHint: "请先运行一次 `kimi` 刷新登录态，或设置 KIMI_API_KEY",
    oauthFallback: true,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    authHint: "请检查 OPENAI_API_KEY",
  },
};

const GENERIC_AUTH_HINT = "请设置 api_key（环境变量或配置文件）";

export async function createLLM(config: LLMFactoryConfig = {}): Promise<BuiltLLM> {
  const provider = config.provider ?? "kimi";
  const defaults = PROVIDERS[provider];

  let baseUrl = config.baseUrl;
  let model = config.model;
  let authHint = GENERIC_AUTH_HINT;
  if (defaults !== undefined) {
    baseUrl ??= defaults.baseUrl;
    model ??= defaults.model;
    authHint = defaults.authHint;
  }
  // 未知 provider = 自定义 OpenAI 兼容端点：默认值无从谈起，必须显式给 base_url/model
  if (baseUrl === undefined) {
    throw new Error(`provider "${provider}" 需要显式配置 base_url（配置文件或环境变量）`);
  }
  if (model === undefined) {
    throw new Error(`provider "${provider}" 需要显式配置 model（配置文件或环境变量）`);
  }

  let apiKey = config.apiKey;
  if (apiKey === undefined && defaults?.oauthFallback) {
    apiKey = await readKimiOAuthToken(config.homeDir);
  }
  if (apiKey === undefined) {
    throw new Error(`未找到 API key：${authHint}`);
  }

  const credentials: LLMCredentials = { apiKey, baseUrl, model };
  const llm = new OpenAICompatibleLLM(credentials, { authHint });
  return { llm, provider, model, webCredentials: { apiKey, baseUrl } };
}
