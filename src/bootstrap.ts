import { join } from "node:path";
import { EventBus } from "./engine/events.ts";
import { resolveKimiCredentials } from "./engine/llm/credentials.ts";
import { FakeLLM } from "./engine/llm/fake.ts";
import { KimiLLM } from "./engine/llm/kimi.ts";
import type { LLMRequester } from "./engine/llm/types.ts";
import { Loop } from "./engine/loop.ts";
import { registerBuiltinTools } from "./engine/tools/builtins.ts";
import { ToolExecutor } from "./engine/tools/executor.ts";
import { WireService } from "./engine/wire.ts";

const SYSTEM_PROMPT = `You are a minimal coding agent running in a terminal. \
Your workspace is the current directory. \
Use the provided tools (read_file / write_file / run_command) to act on files, \
then answer briefly. Paths are relative to the workspace.`;

export interface Agent {
  loop: Loop;
  bus: EventBus;
  wire: WireService;
  workspace: string;
}

export interface BootstrapOptions {
  workspace: string;
  /** FAKE_LLM=1 时用预置脚本演示，无需任何凭证。 */
  fake?: boolean;
}

/** 组合根：显式装配 Engine 各部件。 */
export async function bootstrap(options: BootstrapOptions): Promise<Agent> {
  const workspace = options.workspace;
  const bus = new EventBus();
  const wire = new WireService(join(workspace, "wire.jsonl"));
  const executor = new ToolExecutor();
  registerBuiltinTools(executor, workspace);

  const llm: LLMRequester = options.fake ? demoScript() : new KimiLLM(await resolveKimiCredentials());

  const loop = new Loop({ llm, executor, bus, wire, systemPrompt: SYSTEM_PROMPT });
  return { loop, bus, wire, workspace };
}

/** fake 演示脚本：写 hello.txt → 读回 → 总结。 */
function demoScript(): FakeLLM {
  return new FakeLLM([
    [
      { type: "text", text: "我来演示一下工具调用。\n" },
      {
        type: "tool_call",
        id: "demo-1",
        name: "write_file",
        args: { path: "hello.txt", content: "hello from fake llm\n" },
      },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "tool_call", id: "demo-2", name: "read_file", args: { path: "hello.txt" } },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text", text: "已写入 hello.txt 并读回验证，内容正确。（这是 FAKE_LLM 预置脚本）" },
      { type: "finish", reason: "stop" },
    ],
  ]);
}
