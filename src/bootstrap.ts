import { createComposedGate, alwaysMemoryFrom } from "./engine/approval/composed-gate.ts";
import type { ApprovalGate } from "./engine/approval/gate.ts";
import { createPrintAnswerer } from "./engine/approval/print-answerer.ts";
import { EventBus } from "./engine/events.ts";
import { resolveKimiCredentials } from "./engine/llm/credentials.ts";
import { FakeLLM } from "./engine/llm/fake.ts";
import { KimiLLM } from "./engine/llm/kimi.ts";
import type { LLMRequester, Message } from "./engine/llm/types.ts";
import { Loop } from "./engine/loop.ts";
import { describeConfigSources, loadEffectiveConfig, resolveSystemPrompt } from "./engine/config.ts";
import { SessionStore } from "./engine/session.ts";
import { registerBuiltinTools } from "./engine/tools/builtins.ts";
import { ToolExecutor } from "./engine/tools/executor.ts";
import { registerWebTools } from "./engine/tools/web.ts";
import { Rebuilder, WireService, type RebuiltMessage } from "./engine/wire.ts";

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
  /** 当前会话的 wire 文件（#30：按工作区分目录、按会话分文件）。 */
  sessionPath: string;
  /** 冷重建的历史（UI 展示通道；上下文已进 loop）。新会话为空数组。 */
  history: RebuiltMessage[];
  /** 从 wire 还原的「始终允许」记忆键（#26 的会话记忆在恢复后延续）。 */
  approvalMemory: string[];
  /** 生效的系统 prompt（#39：显式配置 > .agent.md > 内置默认）。 */
  systemPrompt: string;
}

export interface BootstrapOptions {
  workspace: string;
  /** FAKE_LLM=1 时用预置脚本演示，无需任何凭证。 */
  fake?: boolean;
  /** print 模式审批策略（#27）：给了才装配审批 gate；TUI 模式由 #28 装配自己的 gate。 */
  printApproval?: { yes: boolean };
  /** 会话策略（#6）：continue = 继续工作区最近会话（TUI 用）；new/缺省 = 新会话（print 用）。 */
  session?: "new" | "continue";
  /** 测试缝：覆盖会话根目录（默认 ~/.mini-agent/sessions）。 */
  sessionRoot?: string;
  /** 测试缝：覆盖 home 目录（配置文件用户级查找）。 */
  homeDir?: string;
}

/** 组合根：显式装配 Engine 各部件。 */
export async function bootstrap(options: BootstrapOptions): Promise<Agent> {
  const workspace = options.workspace;
  const bus = new EventBus();

  // 会话文件（#30）：按工作区分目录；continue 复用最近会话并冷重建（#29）
  const store = new SessionStore(options.sessionRoot ?? SessionStore.defaultRoot(), workspace);
  let sessionPath: string;
  let history: RebuiltMessage[] = [];
  let contextMessages: Message[] = [];
  let approvalMemory: string[] = [];
  if (options.session === "continue") {
    const latest = await store.latestPath();
    if (latest !== undefined) {
      sessionPath = latest;
      const rows = await new WireService(latest).readAll();
      const rebuilder = new Rebuilder();
      history = rebuilder.rebuild(rows);
      contextMessages = rebuilder.rebuildForContext(rows);
      approvalMemory = [...alwaysMemoryFrom(rows)];
    } else {
      sessionPath = store.createPath();
    }
  } else {
    // print 会话进 print/ 子目录，不污染 TUI 的「继续上次」
    sessionPath = store.createPath(options.printApproval ? "print" : "chat");
  }
  const wire = new WireService(sessionPath);
  const executor = new ToolExecutor();
  registerBuiltinTools(executor, workspace);

  // 配置合并（#38）：env > 项目级 .agent.json > 用户级 config.json
  const config = await loadEffectiveConfig(workspace, options.homeDir);

  // 系统 prompt（#39）：显式配置 > 项目级 .agent.md > 内置默认
  const { prompt: systemPrompt, source: promptSource } = await resolveSystemPrompt(config, workspace, SYSTEM_PROMPT);

  let llm: LLMRequester;
  let model: string;
  if (options.fake) {
    llm = demoScript();
    model = "fake-llm";
  } else {
    const credentials = await resolveKimiCredentials(config);
    llm = new KimiLLM(credentials);
    model = credentials.model;
    // web 工具复用同一份订阅凭证（#3：search/fetch 与 LLM 共用 baseUrl + Bearer）
    registerWebTools(executor, { apiKey: credentials.apiKey, baseUrl: credentials.baseUrl });
    // 生效来源打印（脱敏：只打字段与来源，不打值）
    process.stderr.write(
      `[config]\n${describeConfigSources(config, "kimi-code 订阅 OAuth")}\n  systemPrompt ← ${promptSource}\n`,
    );
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
    systemPrompt,
    ...(approvalGate ? { approvalGate } : {}),
  });
  if (contextMessages.length > 0) {
    loop.loadHistory(contextMessages);
  }
  return { loop, bus, wire, workspace, model, sessionPath, history, approvalMemory, systemPrompt };
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
