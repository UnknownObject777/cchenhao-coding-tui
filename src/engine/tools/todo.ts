/**
 * todo 工具（#58）：会话级计划跟踪。全量覆盖式提交——模型每次交完整列表，
 * 身份 = content（保持 content 稳定、只改 status）；状态机 pending / in_progress / done，
 * 同时至多一个 in_progress；[] 清空。结果回灌确认列表供模型下一轮引用。
 * 纯内存态（审批 read 级，不打扰）；状态事实经 TodoStore.onChange → todo.updated 事件进 wire。
 */
import type { TodoItem, TodoStore } from "../todo.ts";
import type { ToolExecutor } from "./executor.ts";

export function registerTodoTool(executor: ToolExecutor, store: TodoStore): void {
  executor.register({
    name: "todo",
    description:
      "Maintain a todo list to track multi-step work. Submit the COMPLETE list on every call " +
      "(this tool overwrites, it does not patch): keep each item's content stable and change only its status. " +
      "status is one of pending | in_progress | done, and at most one item may be in_progress at a time. " +
      "Pass an empty array to clear the list. The confirmed list is echoed back in the result.",
    approval: "read",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete todo list to store",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Todo text; keep it stable across calls" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    execute: (args) => {
      const accepted = store.replace(args["todos"]);
      return formatTodos(accepted);
    },
  });
}

/** 回灌给模型的确认文本：编号 + 状态标记 + 内容。 */
function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "todos: none (cleared)";
  const lines = items.map((item, i) => `${i + 1}. [${item.status}] ${item.content}`);
  return `todos (${items.length}):\n${lines.join("\n")}`;
}
