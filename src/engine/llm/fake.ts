import type { LLMRequester, Message, ModelEvent, ToolSpec } from "./types.js";

/**
 * 预置脚本的假 LLM：每一轮 request() 弹出脚本中的下一轮事件。
 * 用于无 key 演示与 headless 测试。
 */
export class FakeLLM implements LLMRequester {
  /** 记录每次 request 收到的 messages，供测试断言回灌。 */
  readonly requests: Message[][] = [];
  private round = 0;

  constructor(private readonly script: ModelEvent[][]) {}

  async *request(messages: Message[], _tools: ToolSpec[]): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(messages));
    const events = this.script[this.round];
    this.round += 1;
    if (!events) {
      yield { type: "text", text: "(fake llm: script exhausted)" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    for (const event of events) yield event;
  }
}
