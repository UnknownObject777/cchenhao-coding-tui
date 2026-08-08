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
  "turn.ended": { turnId: number; reason: "finish" | "error"; error?: string };
}

export type EngineEventName = keyof EngineEvents;

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
