import type { TodoItem } from "./todo.ts";

/**
 * 引擎领域事件契约。引擎与 UI 之间唯一的通信通道：
 * UI 只认事件、不碰引擎内部状态。事件类型定义放引擎侧（ADR-0001）。
 */
export interface EngineEvents {
  "turn.started": { turnId: number; prompt: string };
  "assistant.delta": { text: string };
  "assistant.think": { text: string };
  "tool.call": { id: string; name: string; args: Record<string, unknown> };
  "tool.result": { id: string; name: string; ok: boolean; output: string };
  /** 审批询问（含规则引擎判定的级别；deny 级不真发问，仅留痕）。由 gate 实现方发布。 */
  "approval.request": {
    id: string;
    name: string;
    args: Record<string, unknown>;
    level: "confirm" | "deny";
    /** #62 写调用预览：写入前的 unified-ish 变更 diff（读得到旧内容才有；新文件无预览）。 */
    diff?: string;
  };
  /** 审批结论。由 Loop 在 gate 返回后发布。 */
  "approval.decision": { id: string; decision: "allow" | "always" | "deny" };
  /** 上下文占用（#32）：每轮 LLM 请求前与 turn 收尾时发布，footer 显示用。 */
  "context.usage": { estimatedTokens: number; budgetTokens: number };
  /** 上下文压缩（#57）：旧消息被摘要替换、保留最近尾部；wire 重建以此为上下文复位点。 */
  "context.compacted": { summary: string; tailTokens: number };
  /** todo 列表状态事实（#58）：全量覆盖式快照；进 wire 供会话恢复，TUI footer 呈现。 */
  "todo.updated": { items: TodoItem[] };
  "turn.ended": { turnId: number; reason: "finish" | "error"; error?: string };
}

export type EngineEventName = keyof EngineEvents;

/**
 * 运行时可用的事件名清单（stream-json 等需要遍历全部事件的消费方用）。
 * 与 EngineEvents 的一致性由下面的类型级断言保证——加事件不改这里会编译失败。
 */
export const ENGINE_EVENT_NAMES: EngineEventName[] = [
  "turn.started",
  "assistant.delta",
  "assistant.think",
  "tool.call",
  "tool.result",
  "approval.request",
  "approval.decision",
  "context.usage",
  "context.compacted",
  "todo.updated",
  "turn.ended",
];

// 类型级守卫：数组与契约键集互相覆盖
type _AssertNamesCoverContract = Exclude<keyof EngineEvents, (typeof ENGINE_EVENT_NAMES)[number]> extends never
  ? true
  : never;
const _namesCoverContract: _AssertNamesCoverContract = true;
void _namesCoverContract;

export type EngineEvent = {
  [K in EngineEventName]: { type: K } & EngineEvents[K];
}[EngineEventName];

type Handler<T> = (payload: T) => void;

export class EventBus {
  private readonly handlers = new Map<EngineEventName, Set<Handler<never>>>();

  on<K extends EngineEventName>(event: K, handler: Handler<EngineEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends EngineEventName>(event: K, payload: EngineEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as Handler<EngineEvents[K]>)(payload);
    }
  }
}
