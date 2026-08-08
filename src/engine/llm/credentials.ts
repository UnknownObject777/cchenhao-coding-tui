import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KimiCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_MODEL = "kimi-for-coding";
const OAUTH_FILE = join(homedir(), ".kimi-code", "credentials", "kimi-code.json");

/**
 * 凭证优先级（#38/#9）：env（KIMI_API_KEY）> 配置文件合并值（项目级 > 用户级）> kimi-code 订阅 OAuth。
 * OAuth access_token 有效期约 15 分钟，过期时提示用户先跑一次 `kimi` 刷新（玩具不做自动刷新）。
 */
export async function resolveKimiCredentials(config: Partial<KimiCredentials> = {}): Promise<KimiCredentials> {
  const baseUrl = process.env["KIMI_BASE_URL"] ?? config.baseUrl ?? DEFAULT_BASE_URL;
  const model = process.env["KIMI_MODEL"] ?? config.model ?? DEFAULT_MODEL;

  const envKey = process.env["KIMI_API_KEY"];
  if (envKey) return { apiKey: envKey, baseUrl, model };
  if (config.apiKey !== undefined) return { apiKey: config.apiKey, baseUrl, model };

  let raw: string;
  try {
    raw = await readFile(OAUTH_FILE, "utf8");
  } catch {
    throw new Error(
      "未找到 KIMI_API_KEY，也没有 kimi-code 订阅凭证。请设置 KIMI_API_KEY，或先运行 `kimi` 登录订阅。",
    );
  }
  const token = JSON.parse(raw) as { access_token?: string; expires_at?: number };
  if (!token.access_token) {
    throw new Error(`订阅凭证文件缺少 access_token: ${OAUTH_FILE}`);
  }
  if (typeof token.expires_at === "number" && token.expires_at * 1000 < Date.now() + 30_000) {
    throw new Error("kimi-code 订阅 token 已过期，请先运行一次 `kimi` 刷新登录态，或改用 KIMI_API_KEY。");
  }
  return { apiKey: token.access_token, baseUrl, model };
}
