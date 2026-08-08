/**
 * 真实 LLM 实现：fetch 直连 OpenAI 兼容 chat completions，SSE 流式解析。
 * 错误分类（#40）与有限重试（#41）：仅网络错误与 5xx 指数退避（默认上限 2 次），
 * 4xx 不重试；不做 OAuth 自动刷新——保持玩具诚实。
 */
import type { KimiCredentials } from "./credentials.ts";
import { ChunkConverter, parseSseData, type ChatChunk } from "./kimi-stream.ts";
import type { LLMRequester, Message, ModelEvent, ToolSpec } from "./types.ts";

export interface KimiLLMDeps {
  /** 测试缝：替换全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 重试上限（不含首次），默认 2。 */
  maxRetries?: number;
  /** 测试缝：替换退避等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** HTTP 状态 → 用户可操作的分类错误（#40）。 */
export function classifyHttpError(status: number, detail: string): Error {
  const suffix = detail === "" ? "" : `：${detail.slice(0, 300)}`;
  if (status === 401 || status === 403) {
    return new Error(`凭证问题（HTTP ${status}）：请先运行一次 \`kimi\` 刷新登录态，或设置 KIMI_API_KEY${suffix}`);
  }
  if (status === 429) {
    return new Error(`限流（HTTP 429）：请求太密，稍后再试${suffix}`);
  }
  if (status >= 500) {
    return new Error(`服务故障（HTTP ${status}）：上游服务暂时不可用，可稍后重试${suffix}`);
  }
  return new Error(`LLM request failed: HTTP ${status}${suffix}`);
}

function isNetworkError(error: unknown): boolean {
  // undici 的网络失败统一是 TypeError（fetch failed）
  return error instanceof TypeError;
}

export class KimiLLM implements LLMRequester {
  private readonly options: KimiCredentials;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: KimiCredentials, deps: KimiLLMDeps = {}) {
    this.options = options;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.maxRetries = deps.maxRetries ?? 2;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 首次建连：网络错误与 5xx 指数退避重试（500ms 起，×2）；4xx 直接分类抛出。 */
  private async connect(body: string): Promise<Response> {
    const { apiKey, baseUrl } = this.options;
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    let lastError: Error | undefined;

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
        if (isNetworkError(error) && attempt < this.maxRetries) {
          lastError = error as Error;
          continue;
        }
        throw isNetworkError(error)
          ? new Error(`网络错误：${(error as Error).message}（检查网络/代理；已重试 ${attempt} 次）`)
          : error;
      }

      if (response.ok && response.body) return response;

      const detail = await response.text().catch(() => "");
      if (response.status >= 500 && attempt < this.maxRetries) {
        lastError = classifyHttpError(response.status, detail);
        continue;
      }
      throw classifyHttpError(response.status, detail);
    }
    throw lastError ?? new Error("LLM request failed: retries exhausted");
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
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        for (const payload of parseSseData(line)) {
          yield* converter.push(JSON.parse(payload) as ChatChunk);
        }
        newline = buffer.indexOf("\n");
      }
    }
    for (const payload of parseSseData(buffer)) {
      yield* converter.push(JSON.parse(payload) as ChatChunk);
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
