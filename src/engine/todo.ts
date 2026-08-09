/**
 * todo 列表状态（#58）：会话级、全量覆盖式的内存态。
 * 契约：模型每次提交完整列表，身份 = content（保持 content 稳定、只改 status）；
 * 状态机 pending / in_progress / done，同时至多一个 in_progress；空数组 = 清空。
 * 状态变更经 onChange 回调发布（bootstrap 装配成双通道：bus 事件给 TUI + wire 落盘）。
 * 范围外（#51 玩具约束）：跨会话持久化、子任务嵌套、优先级/标签。
 */
export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const ALLOWED_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"];

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (ALLOWED_STATUSES as readonly string[]).includes(value);
}

export class TodoStore {
  private items: TodoItem[] = [];

  /** 状态变更回调（发布通道）。replace 成功后才触发；restore 静默（恢复不是新事实）。 */
  onChange: (items: TodoItem[]) => void = () => {};

  /** 当前列表快照（副本，调用方改动不影响内部态）。 */
  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /**
   * wire 恢复（会话冷启动）：静默注入、不做校验报错——坏数据丢弃而非拖死恢复（#42 容忍精神）。
   * 非法状态 / 空 content 的条目丢弃；多个 in_progress 保第一个、其余降为 pending，维持不变量。
   */
  restore(items: TodoItem[]): void {
    const kept: TodoItem[] = [];
    let inProgressSeen = false;
    for (const item of items) {
      if (typeof item.content !== "string" || item.content === "" || !isTodoStatus(item.status)) continue;
      if (item.status === "in_progress") {
        if (inProgressSeen) {
          kept.push({ content: item.content, status: "pending" });
          continue;
        }
        inProgressSeen = true;
      }
      kept.push({ ...item });
    }
    this.items = kept;
  }

  /**
   * 全量覆盖式写入（工具调用入口）。校验失败抛可行动错误：状态不变、不触发 onChange。
   * 成功：替换整个列表 → 触发 onChange → 返回确认后的列表（供工具回灌给模型）。
   */
  replace(raw: unknown): TodoItem[] {
    if (!Array.isArray(raw)) {
      throw new Error('todo: "todos" must be an array of {content, status}');
    }
    const validated: TodoItem[] = [];
    const inProgressContents: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error("todo: each entry must be an object {content, status}");
      }
      const { content, status } = entry as Record<string, unknown>;
      if (typeof content !== "string" || content === "") {
        throw new Error("todo content must be a non-empty string");
      }
      if (!isTodoStatus(status)) {
        throw new Error(
          `invalid todo status "${String(status)}" for "${content}": allowed values are pending | in_progress | done`,
        );
      }
      if (status === "in_progress") inProgressContents.push(content);
      validated.push({ content, status });
    }
    if (inProgressContents.length > 1) {
      throw new Error(
        `more than one in_progress todo: ${inProgressContents.map((c) => `"${c}"`).join(", ")}. ` +
          "At most one item may be in_progress; set the others back to pending.",
      );
    }
    this.items = validated.map((item) => ({ ...item }));
    this.onChange(this.items);
    return this.list();
  }
}
