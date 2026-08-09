/**
 * footer 状态栏（#48）：模型 + 工作区 + 审批模式 + 上下文占用 + todo 进度（#58）。
 * 信息单源：装配时经 FooterInfo 注入（bootstrap → app.ts）；
 * 占用经 context.usage 事件驱动（setUsage），≥70% 预算换 warning 色；
 * todo 经 todo.updated 事件驱动（setTodos），恢复会话由 app.ts 用 agent.todos 预置。
 */
import { truncateToWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import type { TodoItem } from "../../../engine/todo.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export interface FooterInfo {
  model: string;
  cwd: string;
  /** 审批模式展示文案（如 "审批:交互"），装配侧单源注入（#48）。 */
  approvalLabel: string;
}

/** 占用超过该比例时换警示色。 */
const USAGE_WARN_RATIO = 0.7;
/** todo 当前任务在 footer 里的内容上限（防长任务名挤掉 ctx 占用）。 */
const TODO_ACTIVE_MAX_LENGTH = 24;

export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);
}

export class FooterComponent implements Component {
  private readonly info: FooterInfo;
  private usage: { estimatedTokens: number; budgetTokens: number } | undefined;
  private todos: TodoItem[] | undefined;

  constructor(info: FooterInfo) {
    this.info = info;
  }

  setUsage(estimatedTokens: number, budgetTokens: number): void {
    this.usage = { estimatedTokens, budgetTokens };
  }

  /** todo 状态快照（#58）：undefined = 从未设置（不显示段）；[] = 已清空（也不显示）。 */
  setTodos(items: TodoItem[]): void {
    this.todos = items;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    let line =
      hex("textDim")(` ${this.info.model} · ${this.info.cwd}`) +
      hex("textMuted")(` · ${this.info.approvalLabel}`);
    if (this.usage !== undefined) {
      const { estimatedTokens, budgetTokens } = this.usage;
      const text = ` · ctx ${formatTokenCount(estimatedTokens)}/${formatTokenCount(budgetTokens)}`;
      line += estimatedTokens / budgetTokens >= USAGE_WARN_RATIO ? hex("warning")(text) : hex("textMuted")(text);
    }
    const todoText = formatTodoSegment(this.todos);
    if (todoText !== "") {
      line += hex("textMuted")(` · todo ${todoText}`);
    }
    return [truncateToWidth(line, safeWidth, "…")];
  }
}

/** todo 段：`2/5: 当前任务`；空列表/未设置返回 ""（不渲染）。 */
function formatTodoSegment(todos: TodoItem[] | undefined): string {
  if (todos === undefined || todos.length === 0) return "";
  const done = todos.filter((item) => item.status === "done").length;
  const active = todos.find((item) => item.status === "in_progress");
  let text = `${done}/${todos.length}`;
  if (active !== undefined) {
    const content = active.content.length > TODO_ACTIVE_MAX_LENGTH
      ? active.content.slice(0, TODO_ACTIVE_MAX_LENGTH) + "…"
      : active.content;
    text += `: ${content}`;
  }
  return text;
}
