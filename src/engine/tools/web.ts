/**
 * web_search / web_fetch（#35/#36，按 #3 调研封装）：
 * POST + Bearer 复用订阅凭证；search 返 JSON 数组、fetch 返纯 markdown。
 * 401/402/403 归类认证/额度错误，不重试（玩具不做 OAuth 自动刷新）。
 */
import type { ToolExecutor } from "./executor.ts";
import { TOOL_OUTPUT_MAX_BYTES, truncateBytes } from "./truncate.ts";

export interface WebToolsOptions {
  apiKey: string;
  /** 如 https://api.kimi.com/coding/v1，端点派生为 {baseUrl}/search|fetch。 */
  baseUrl: string;
  /** 测试缝：替换全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 测试缝：覆盖超时（默认 search 15s / fetch 30s）。 */
  timeouts?: { searchMs?: number; fetchMs?: number };
}

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;

interface SearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  site_name?: string;
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403;
}

async function errorFromResponse(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body: unknown = await response.json();
    // OpenAI 风格错误包络：{"error": {"message": ...}}
    detail =
      (body as { error?: { message?: string } })?.error?.message ?? JSON.stringify(body).slice(0, 200);
  } catch {
    detail = response.statusText;
  }
  if (isAuthStatus(response.status)) {
    return new Error(
      `HTTP ${response.status} 认证/额度错误：${detail}（请重新登录 kimi 刷新凭证或检查 KIMI_API_KEY；不重试）`,
    );
  }
  return new Error(`HTTP ${response.status}: ${detail}`);
}

export function registerWebTools(executor: ToolExecutor, options: WebToolsOptions): void {
  const doFetch = options.fetchFn ?? fetch;
  const searchTimeout = options.timeouts?.searchMs ?? SEARCH_TIMEOUT_MS;
  const fetchTimeout = options.timeouts?.fetchMs ?? FETCH_TIMEOUT_MS;

  const postJson = (endpoint: string, body: unknown, timeoutMs: number, extraHeaders: Record<string, string> = {}) =>
    doFetch(`${options.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  executor.register({
    name: "web_search",
    description:
      "Search the web. Returns results with Title/URL/Snippet (+Site/Date when available); use web_fetch on a URL for full text.",
    parameters: {
      type: "object",
      properties: { text_query: { type: "string" } },
      required: ["text_query"],
    },
    execute: async (args) => {
      const response = await postJson("/search", { text_query: String(args["text_query"]) }, searchTimeout);
      if (!response.ok) throw await errorFromResponse(response);

      const data = (await response.json()) as { search_results?: SearchResultItem[] };
      // 只取 title/url/snippet(+date/site)，丢 content/icon（#3：content 一条 2KB+，对上下文不友好）
      return (data.search_results ?? [])
        .map((item, index) =>
          [
            `[${index + 1}] Title: ${item.title ?? ""}`,
            `Site: ${item.site_name ?? ""}`,
            `Date: ${item.date ?? ""}`,
            `URL: ${item.url ?? ""}`,
            `Snippet: ${item.snippet ?? ""}`,
          ].join("\n"),
        )
        .join("\n\n");
    },
  });

  executor.register({
    name: "web_fetch",
    description: "Fetch a web page as markdown via the subscription fetch endpoint.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "http(s) URL" } },
      required: ["url"],
    },
    execute: async (args) => {
      const url = String(args["url"]);
      if (!/^https?:\/\/.+/.test(url)) {
        throw new Error(`invalid url (only http/https supported): ${url}`);
      }
      const response = await postJson("/fetch", { url }, fetchTimeout, { Accept: "text/markdown" });
      if (!response.ok) throw await errorFromResponse(response);

      // 内存护栏按真字节截断（#36 的 50KB）；外层 executor 护栏仍兜底
      return truncateBytes(await response.text(), TOOL_OUTPUT_MAX_BYTES);
    },
  });
}
