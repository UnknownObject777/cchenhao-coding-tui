import { ChunkConverter, parseSseData, type ChatChunk } from "./kimi-stream.js";
import type { LLMRequester, Message, ModelEvent, ToolSpec } from "./types.js";

export interface KimiLLMOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * 真实 LLM 实现：fetch 直连 OpenAI 兼容 chat completions，SSE 流式解析。
 * 只做 HTTP 拉取：不重试、不刷新鉴权、不做背压——超出范围直接抛错，保持玩具诚实。
 */
export class KimiLLM implements LLMRequester {
  constructor(private readonly options: KimiLLMOptions) {}

  async *request(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent> {
    const { apiKey, baseUrl, model } = this.options;
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(messages),
        tools: tools.map(toOpenAITool),
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`LLM request failed: HTTP ${response.status} ${detail.slice(0, 500)}`);
    }

    const converter = new ChunkConverter();
    const reader = response.body.getReader();
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
