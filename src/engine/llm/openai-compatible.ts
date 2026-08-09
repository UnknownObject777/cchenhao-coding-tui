/**
 * OpenAI 兼容 LLM 实现：fetch 直连 OpenAI 兼容 chat completions，SSE 流式解析。
 * kimi 订阅端点与其同形，仅默认值/凭证兜底/错误提示按 provider 参数化（#55）。
 * 错误分类（#40）与有限重试（#41）：仅网络错误与 5xx 指数退避（默认上限 2 次），
 * 4xx 不重试；不做 OAuth 自动刷新——保持玩具诚实。
 */
import { ChunkConverter, parseSseData, SseLineSplitter, type ChatChunk } from "./kimi-stream.ts";
import type { LLMRequester, Message, ModelEvent, ToolSpec } from "./types.ts";

export interface LLMCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface OpenAICompatibleLLMDeps {
  /** 测试缝：替换全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 重试上限（不含首次），默认 2。 */
  maxRetries?: number;
  /** 测试缝：替换退避等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 401/403 时的可操作提示（按 provider 参数化，#55）。 */
  authHint?: string;
}

/** HTTP 状态 → 用户可操作的分类错误（#40）；authHint 缺省用通用提示。 */
export function classifyHttpError(status: number, detail: string, authHint?: string): Error {
  // 上游错误体可能回显请求头，先剥 Bearer 再展示（防 token 泄漏）
  const safeDetail = detail.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 300);
  const suffix = safeDetail === "" ? "" : `：${safeDetail}`;
  if (status === 401 || status === 403) {
    return new Error(`凭证问题（HTTP ${status}）：${authHint ?? "请检查 API key 配置"}${suffix}`);
  }
  if (status === 429) {
    return new Error(`限流（HTTP 429）：请求太密，稍后再试${suffix}`);
  }
  if (status >= 500) {
    return new Error(`服务故障（HTTP ${status}）：上游服务暂时不可用，可稍后重试${suffix}`);
  }
  return new Error(`LLM 请求失败（HTTP ${status}）${suffix}`);
}

function isNetworkError(error: unknown): boolean {
  // undici 的网络失败是 TypeError("fetch failed")；配置错误（如非法 baseUrl 的
  // "Invalid URL" TypeError）不算网络错误，不重试、不误诊
  return error instanceof TypeError && error.message.includes("fetch failed");
}

/** 容忍用户直接填完整端点：已含 /chat/completions 则不重复拼接。 */
function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

export class OpenAICompatibleLLM implements LLMRequester {
  private readonly options: LLMCredentials;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly authHint?: string;

  constructor(options: LLMCredentials, deps: OpenAICompatibleLLMDeps = {}) {
    this.options = options;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.maxRetries = deps.maxRetries ?? 2;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.authHint = deps.authHint;
  }

  /** 首次建连：网络错误与 5xx 指数退避重试（500ms 起，×2）；4xx 直接分类抛出。 */
  private async connect(body: string): Promise<Response> {
    const { apiKey, baseUrl } = this.options;
    const url = chatCompletionsUrl(baseUrl);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(500 * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body,
        });
      } catch (error) {
        if (isNetworkError(error)) {
          if (attempt < this.maxRetries) continue;
          throw new Error(`网络错误：${(error as Error).message}（检查网络/代理；已重试 ${attempt} 次）`);
        }
        throw error;
      }

      if (response.ok && response.body) return response;

      const detail = await response.text().catch(() => "");
      if (response.status >= 500 && attempt < this.maxRetries) continue;
      throw classifyHttpError(response.status, detail, this.authHint);
    }
    // 循环必从 return/throw 退出（continue 有 attempt 上限守卫）
    throw new Error("unreachable");
  }

  async *request(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent> {
    const body = JSON.stringify({
      model: this.options.model,
      messages: toOpenAIMessages(messages),
      tools: tools.map(toOpenAITool),
      stream: true,
    });
    const response = await this.connect(body);

    const converter = new ChunkConverter();
    const splitter = new SseLineSplitter();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const feed = function* (line: string): Generator<ModelEvent> {
      for (const payload of parseSseData(line)) {
        yield* converter.push(JSON.parse(payload) as ChatChunk);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
        yield* feed(line);
      }
    }
    for (const line of splitter.flush()) {
      yield* feed(line);
    }
    yield* converter.end();
  }
}
type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
      case "user":
        return { role: message.role, content: message.content };
      case "assistant":
        return {
          role: "assistant",
          content: message.content === "" ? null : message.content,
          ...(message.toolCalls
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
  });
}

function toOpenAITool(tool: ToolSpec): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}
