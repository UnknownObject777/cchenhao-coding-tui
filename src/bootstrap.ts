import { join } from "node:path";
import { createComposedGate } from "./engine/approval/composed-gate.ts";
import type { ApprovalGate } from "./engine/approval/gate.ts";
import { createPrintAnswerer } from "./engine/approval/print-answerer.ts";
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
  /** 生效的模型名（fake 模式为 "fake-llm"），供 UI 展示。 */
  model: string;
}

export interface BootstrapOptions {
  workspace: string;
  /** FAKE_LLM=1 时用预置脚本演示，无需任何凭证。 */
  fake?: boolean;
  /** print 模式审批策略（#27）：给了才装配审批 gate；TUI 模式由 #28 装配自己的 gate。 */
  printApproval?: { yes: boolean };
}

/** 组合根：显式装配 Engine 各部件。 */
export async function bootstrap(options: BootstrapOptions): Promise<Agent> {
  const workspace = options.workspace;
  const bus = new EventBus();
  const wire = new WireService(join(workspace, "wire.jsonl"));
  const executor = new ToolExecutor();
  registerBuiltinTools(executor, workspace);

  let llm: LLMRequester;
  let model: string;
  if (options.fake) {
    llm = demoScript();
    model = "fake-llm";
  } else {
    const credentials = await resolveKimiCredentials();
    llm = new KimiLLM(credentials);
    model = credentials.model;
  }

  const approvalGate: ApprovalGate | undefined = options.printApproval
    ? createComposedGate({
        bus,
        workspace,
        answerer: createPrintAnswerer(options.printApproval.yes, (message) =>
          process.stderr.write(`${message}\n`),
        ),
      })
    : undefined;

  const loop = new Loop({
    llm,
    executor,
    bus,
    wire,
    systemPrompt: SYSTEM_PROMPT,
    ...(approvalGate ? { approvalGate } : {}),
  });
  return { loop, bus, wire, workspace, model };
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
