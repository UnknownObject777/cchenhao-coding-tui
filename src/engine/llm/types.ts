/** LLM 流事件：判别联合。引擎消费 AsyncIterable<ModelEvent>。 */
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "think"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "finish"; reason: "stop" | "tool_calls" | string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMRequester {
  request(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent>;
}
