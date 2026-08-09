import type { ApprovalGate } from "./approval/gate.ts";
import {
  COMPACT_TAIL_FRACTION,
  CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  splitForCompaction,
  SUMMARIZATION_SYSTEM_PROMPT,
  summaryMessage,
  TRUNCATE_HIGH_WATER,
  TRUNCATE_LOW_WATER,
  truncateToWindow,
} from "./context.ts";
import type { EventBus, EngineEvent, EngineEventName, EngineEvents } from "./events.ts";
import type { LLMRequester, Message, ToolCall } from "./llm/types.ts";
import { errorMessage, type ToolExecutor } from "./tools/executor.ts";
import type { EventSink } from "./wire.ts";

export interface LoopOptions {
  llm: LLMRequester;
  executor: ToolExecutor;
  bus: EventBus;
  systemPrompt: string;
  /** 事件落盘缝：排序与失败语义由 sink 实现保证；缺省不落盘。 */
  sink?: EventSink;
  /** 审批缝（#5）：tool.call 发布后、执行前 await；缺省不审批。 */
  approvalGate?: ApprovalGate;
  /** 上下文 token 预算（#31）；缺省 256K（kimi-for-coding）。 */
  contextTokenBudget?: number;
  /** 单个 turn 内 LLM 往返的最大轮数（防 tool call 死循环）。 */
  maxRounds?: number;
}

/**
 * turn 状态机：组装 messages → 消费 LLM 流 → 发布领域事件 →
 * tool_call 交 executor、结果回灌 → finish 后发 turn.ended。
 */
export class Loop {
  private messages: Message[] = [];
  private turnCount = 0;

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

  /** 装配后置 gate（TUI 的审批应答源依赖 UI 部件，只能在组件树搭好后注入，#28）。 */
  setApprovalGate(gate: ApprovalGate): void {
    this.options.approvalGate = gate;
  }

  /** 会话恢复（#29）：把冷重建的历史消息注入上下文（system prompt 之后）。 */
  loadHistory(messages: Message[]): void {
    this.messages.push(...messages);
  }

  /**
   * 注入一条上下文消息（#59：slash 触发 skill 等价模型经 load_skill 工具自取）。
   * user 角色、不进 wire——纯上下文，会话恢复后需重新触发（玩具可接受，todo 之类有状态事实才走事件通道）。
   */
  injectContext(content: string): void {
    this.messages.push({ role: "user", content });
  }

  /**
   * 手动压缩（/compact 兜底，#57）：摘要头部旧消息、保留最近尾部。
   * 无可压缩内容（head 为空）返回 false，不烧 LLM 调用。
   */
  async compact(): Promise<boolean> {
    return this.compactContext();
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
          this.publishUsage(); // turn 收尾的占用（footer 不滞后一轮）
          this.publish("turn.ended", { turnId, reason: "finish" });
          await this.options.sink?.flush();
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
    await this.options.sink?.flush();
  }

  /** 跑一轮 LLM 往返；返回 true 表示本轮无 tool call、turn 收尾，false 表示还要回灌续轮。 */
  private async runRound(): Promise<boolean> {
    const { llm, executor } = this.options;
    await this.enforceContextWindow();
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
      const gate = this.options.approvalGate;
      if (gate !== undefined) {
        const decision = await gate.request(call);
        this.publish("approval.decision", { id: call.id, decision });
        if (decision === "deny") {
          // 拒绝回灌成 tool 结果让模型自纠（协议要求每个 tool_call 都有 tool 回复）
          this.pushToolResult(call, false, `tool call denied by approval policy: ${call.name}`);
          continue;
        }
      }
      const result = await executor.execute(call.name, call.args);
      this.pushToolResult(call, result.ok, result.output);
    }
    return false;
  }

  /** 发布 tool.result 并把 tool 消息回灌进上下文（每个 tool_call 必须有 tool 回复）。 */
  private pushToolResult(call: ToolCall, ok: boolean, output: string): void {
    this.publish("tool.result", { id: call.id, name: call.name, ok, output });
    this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
  }

  private get contextTokenBudget(): number {
    return this.options.contextTokenBudget ?? CONTEXT_TOKEN_BUDGET;
  }

  /**
   * 溢出防线（#31，#7 决策，#57 升级为真压缩）：
   * 估算超 80% 预算时，先 compaction——一次 LLM 摘要调用把头部降成一条 user 摘要，
   * 保留最近尾部（整组不拆 tool 配对）；摘要调用失败退化为滑动窗口截断。
   * 压缩/截断后仍超（单条巨型消息）抛错，由 runTurn 转成 turn.ended(error) 引导 /clear。
   * 每次 LLM 请求前调用，并顺带发布 context.usage。
   */
  private async enforceContextWindow(): Promise<void> {
    const budget = this.contextTokenBudget;
    let estimated = estimateTokens(this.messages);
    if (estimated > budget * TRUNCATE_HIGH_WATER) {
      // compaction 语义覆盖截断（丢旧 + 保近 + 旧上下文留摘要），摘要失败才走截断兜底
      const compacted = await this.compactContext().catch(() => false);
      estimated = estimateTokens(this.messages);
      if (compacted && estimated > budget * TRUNCATE_HIGH_WATER) {
        // 熔断：压缩后立即回满（如单条巨型消息），不再烧第二次摘要调用
        throw new Error(
          `context overflow: ~${estimated} tokens exceeds budget ${budget} even after compaction; use /clear to start fresh`,
        );
      }
      if (!compacted && estimated > budget * TRUNCATE_HIGH_WATER) {
        this.messages = truncateToWindow(this.messages, Math.floor(budget * TRUNCATE_LOW_WATER));
        estimated = estimateTokens(this.messages);
        if (estimated > budget * TRUNCATE_HIGH_WATER) {
          throw new Error(
            `context overflow: ~${estimated} tokens exceeds budget ${budget} even after truncation; use /clear to start fresh`,
          );
        }
      }
    }
    this.publishUsage();
  }

  /**
   * 上下文压缩（#57）：head（可摘要的旧消息）经一次 LLM 摘要调用降成一条
   * user 摘要消息，保留 tail（最近尾部）原样；新状态 = [system, 摘要, tail]。
   * 压缩是事实：发布 context.compacted 事件（进 wire，供冷重建复位）。
   * 摘要调用失败向上抛，由调用方（enforceContextWindow）退化截断。
   */
  private async compactContext(): Promise<boolean> {
    const tailTokens = Math.floor(this.contextTokenBudget * COMPACT_TAIL_FRACTION);
    const { system, head, tail } = splitForCompaction(this.messages, tailTokens);
    if (head.length === 0) return false;
    const summary = await summarizeMessages(this.options.llm, head);
    this.messages = [...system, summaryMessage(summary), ...tail];
    this.publish("context.compacted", { summary, tailTokens });
    return true;
  }

  private publishUsage(): void {
    this.publish("context.usage", {
      estimatedTokens: estimateTokens(this.messages),
      budgetTokens: this.contextTokenBudget,
    });
  }

  private publish<K extends EngineEventName>(event: K, payload: EngineEvents[K]): void {
    this.options.bus.emit(event, payload);
    this.options.sink?.append({ type: event, ...payload } as EngineEvent);
  }
}

/**
 * 摘要调用（#57）：复用同一 provider 的流式接口做一次非流式语义调用——
 * 无工具，收集全部 text 事件拼成摘要文本。失败向上抛，由调用方决定退化路径。
 */
async function summarizeMessages(llm: LLMRequester, head: Message[]): Promise<string> {
  const prompt: Message[] = [{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT }, ...head];
  let text = "";
  for await (const event of llm.request(prompt, [])) {
    if (event.type === "text") text += event.text;
  }
  return text.trim();
}
