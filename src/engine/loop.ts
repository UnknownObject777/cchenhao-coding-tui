import type { EventBus, EngineEventName, EngineEvents } from "./events.ts";
import type { LLMRequester, Message, ToolCall } from "./llm/types.ts";
import { errorMessage, type ToolExecutor } from "./tools/executor.ts";
import type { WireService } from "./wire.ts";

export interface LoopOptions {
  llm: LLMRequester;
  executor: ToolExecutor;
  bus: EventBus;
  systemPrompt: string;
  wire?: WireService;
  /** 单个 turn 内 LLM 往返的最大轮数（防 tool call 死循环）。 */
  maxRounds?: number;
}

/**
 * turn 状态机：组装 messages → 消费 LLM 流 → 发布领域事件 →
 * tool_call 交 executor、结果回灌 → finish 后发 turn.ended。
 */
export class Loop {
  private readonly messages: Message[] = [];
  private turnCount = 0;
  private wireQueue: Promise<unknown> = Promise.resolve();

  private readonly options: LoopOptions;

  constructor(options: LoopOptions) {
    this.options = options;
    if (options.systemPrompt !== "") {
      this.messages.push({ role: "system", content: options.systemPrompt });
    }
  }

  /** 清空对话上下文（保留 system prompt），/clear 与 /delete 用。turnCount 不复位。 */
  reset(): void {
    this.messages.length = 0;
    if (this.options.systemPrompt !== "") {
      this.messages.push({ role: "system", content: this.options.systemPrompt });
    }
  }

  async runTurn(prompt: string): Promise<void> {
    this.turnCount += 1;
    const turnId = this.turnCount;
    this.messages.push({ role: "user", content: prompt });
    this.publish("turn.started", { turnId, prompt });

    try {
      const maxRounds = this.options.maxRounds ?? 16;
      for (let round = 0; round < maxRounds; round += 1) {
        const finished = await this.runRound();
        if (finished) {
          this.publish("turn.ended", { turnId, reason: "finish" });
          await this.wireQueue;
          return;
        }
      }
      this.publish("turn.ended", { turnId, reason: "error", error: `exceeded max rounds (${maxRounds})` });
    } catch (error) {
      this.publish("turn.ended", {
        turnId,
        reason: "error",
        error: errorMessage(error),
      });
    }
    await this.wireQueue;
  }

  /** 跑一轮 LLM 往返；返回 true 表示本轮无 tool call、turn 收尾，false 表示还要回灌续轮。 */
  private async runRound(): Promise<boolean> {
    const { llm, executor } = this.options;
    let assistantText = "";
    const toolCalls: ToolCall[] = [];

    for await (const event of llm.request(this.messages, executor.definitions())) {
      switch (event.type) {
        case "text":
          assistantText += event.text;
          this.publish("assistant.delta", { text: event.text });
          break;
        case "think":
          this.publish("assistant.think", { text: event.text });
          break;
        case "tool_call":
          toolCalls.push({ id: event.id, name: event.name, args: event.args });
          this.publish("tool.call", { id: event.id, name: event.name, args: event.args });
          break;
        case "finish":
          break;
      }
    }

    const assistantMessage: Message = {
      role: "assistant",
      content: assistantText,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    this.messages.push(assistantMessage);

    // 只要模型吐了 tool_call 就必须执行并回灌——即使 finish_reason 是 "stop"，
    // 否则带 toolCalls 的 assistant 消息没有对应 tool 回复，下一轮请求会被协议拒收。
    if (toolCalls.length === 0) {
      return true;
    }

    for (const call of toolCalls) {
      const result = await executor.execute(call.name, call.args);
      this.publish("tool.result", { id: call.id, name: call.name, ok: result.ok, output: result.output });
      this.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.output,
      });
    }
    return false;
  }

  private publish<K extends EngineEventName>(event: K, payload: EngineEvents[K]): void {
    this.options.bus.emit(event, payload);
    if (this.options.wire) {
      const wire = this.options.wire;
      const row = { type: event, ...payload } as Parameters<WireService["append"]>[0];
      this.wireQueue = this.wireQueue.then(() => wire.append(row));
    }
  }
}
