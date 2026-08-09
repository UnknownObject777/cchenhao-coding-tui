/**
 * kimi-code 订阅 OAuth 兜底凭证（#55 拆分）：
 * 通用凭证合并（env + 双级配置）与 provider 分派在 factory.ts；本文件只保留
 * 「kimi 订阅 OAuth」这一个可选 fallback，其它 provider 无此兜底。
 * OAuth access_token 有效期约 15 分钟，过期时提示用户先跑一次 `kimi` 刷新（玩具不做自动刷新）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 读取 kimi-code 订阅 OAuth token；读不到或已过期时抛错并给出可操作提示。 */
export async function readKimiOAuthToken(home: string = homedir()): Promise<string> {
  const oauthFile = join(home, ".kimi-code", "credentials", "kimi-code.json");
  let raw: string;
  try {
    raw = await readFile(oauthFile, "utf8");
  } catch {
    throw new Error(
      "未找到 KIMI_API_KEY，也没有 kimi-code 订阅凭证。请设置 KIMI_API_KEY，或先运行 `kimi` 登录订阅。",
    );
  }
  const token = JSON.parse(raw) as { access_token?: string; expires_at?: number };
  if (!token.access_token) {
    throw new Error(`订阅凭证文件缺少 access_token: ${oauthFile}`);
  }
  if (typeof token.expires_at === "number" && token.expires_at * 1000 < Date.now() + 30_000) {
    throw new Error("kimi-code 订阅 token 已过期，请先运行一次 `kimi` 刷新登录态，或改用 KIMI_API_KEY。");
  }
  return token.access_token;
}
