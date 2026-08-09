import { homedir } from "node:os";
import { createComposedGate, alwaysMemoryFrom } from "./engine/approval/composed-gate.ts";
import type { ApprovalGate } from "./engine/approval/gate.ts";
import { createPrintAnswerer } from "./engine/approval/print-answerer.ts";
import { EventBus } from "./engine/events.ts";
import { createLLM } from "./engine/llm/factory.ts";
import { FakeLLM } from "./engine/llm/fake.ts";
import type { LLMRequester, Message } from "./engine/llm/types.ts";
import { Loop } from "./engine/loop.ts";
import { describeConfigSources, loadEffectiveConfig, resolveSystemPrompt } from "./engine/config.ts";
import { detectGitDirty } from "./engine/git.ts";
import { SessionStore } from "./engine/session.ts";
import { discoverSkills, formatSkillList, registerSkillTool, type Skill } from "./engine/skills.ts";
import { registerBuiltinTools } from "./engine/tools/builtins.ts";
import { ToolExecutor, type ToolApprovalKind } from "./engine/tools/executor.ts";
import { registerWebTools } from "./engine/tools/web.ts";
import { TodoStore } from "./engine/todo.ts";
import { Rebuilder, WireEventSink, WireService, type RebuiltMessage } from "./engine/wire.ts";

const SYSTEM_PROMPT = `You are a minimal coding agent running in a terminal. \
Your workspace is the current directory. \
Use the provided tools (read_file / write_file / edit_file / run_command) to act on files, \
then answer briefly. Paths are relative to the workspace. \
For a small, targeted change to an existing file use edit_file (old_string/new_string); \
use write_file for new files or large rewrites. \
For multi-step work, maintain a todo list with the todo tool: submit the complete list \
with statuses pending / in_progress / done, keep at most one item in_progress, and rewrite \
the whole list whenever anything changes. For a single quick step, skip todos.`;

export interface Agent {
  loop: Loop;
  bus: EventBus;
  wire: WireService;
  workspace: string;
  /** 工具自声明的审批分类查询（TUI 装配 gate 时用；executor 的窄投影）。 */
  approvalKind: (name: string) => ToolApprovalKind | undefined;
  /** 生效的模型名（fake 模式为 "fake-llm"），供 UI 展示。 */
  model: string;
  /** 当前会话的 wire 文件（#30：按工作区分目录、按会话分文件）。 */
  sessionPath: string;
  /** 冷重建的历史（UI 展示通道；上下文已进 loop）。新会话为空数组。 */
  history: RebuiltMessage[];
  /** 从 wire 还原的「始终允许」记忆键（#26 的会话记忆在恢复后延续）。 */
  approvalMemory: string[];
  /** 生效的系统 prompt（#39：显式配置 > .agent.md > 内置默认；#59：末尾追加 skills 清单）。 */
  systemPrompt: string;
  /** 发现的 skills（#59）：清单进 system prompt，load_skill 工具 + /<skill-name> 按需加载全文。 */
  skills: Skill[];
  /** todo 列表状态（#58）：TUI footer 初始化与恢复会话还原用（实时变更走 todo.updated 事件）。 */
  todos: TodoStore;
}

export interface BootstrapOptions {
  workspace: string;
  /** FAKE_LLM=1 时用预置脚本演示，无需任何凭证。 */
  fake?: boolean;
  /** print 模式审批策略（#27）：给了才装配审批 gate；TUI 模式由 #28 装配自己的 gate。 */
  printApproval?: { yes: boolean };
  /** 会话策略（#6）：continue = 继续最近（TUI 用）；new/缺省 = 新会话（print 用）；{resume} = 指定会话文件（#47 选择器）。 */
  session?: "new" | "continue" | { resume: string };
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
  const todos = new TodoStore();
  const resumePath =
    typeof options.session === "object"
      ? options.session.resume
      : options.session === "continue"
        ? await store.latestPath()
        : undefined;
  if (resumePath !== undefined) {
    sessionPath = resumePath;
    const rows = await new WireService(resumePath).readAll();
    const rebuilder = new Rebuilder();
    history = rebuilder.rebuild(rows);
    contextMessages = rebuilder.rebuildForContext(rows);
    approvalMemory = [...alwaysMemoryFrom(rows)];
    // todo 状态事实还原（#58）：取最后一个 todo.updated 快照，静默注入
    todos.restore(rebuilder.rebuildTodos(rows));
  } else {
    // print 会话进 print/ 子目录，不污染 TUI 的「继续上次」
    sessionPath = store.createPath(options.printApproval ? "print" : "chat");
  }
  const wire = new WireService(sessionPath);
  const sink = new WireEventSink(wire);
  // todo 状态事实双通道（#58，仿 loop.publish）：bus 事件给 TUI，sink 落 wire 供恢复。
  // 挂在 store 变更回调上而非 loop——工具在 executor 内执行，loop 保持工具无关。
  todos.onChange = (items) => {
    bus.emit("todo.updated", { items });
    sink.append({ type: "todo.updated", items });
  };
  const executor = new ToolExecutor();
  registerBuiltinTools(executor, workspace, todos, { sessionPath });

  // 配置合并（#38）：env > 项目级 .agent.json > 用户级 config.json
  const home = options.homeDir ?? homedir();
  const config = await loadEffectiveConfig(workspace, home);

  // 系统 prompt（#39）：显式配置 > 项目级 .agent.md > 内置默认
  const { prompt: promptBase, source: promptSource } = await resolveSystemPrompt(config, workspace, SYSTEM_PROMPT);

  // skills（#59）：发现（项目级 .agents/skills + 用户级 ~/.mini-agent/skills，项目级覆盖用户级）；
  // 清单追加到生效 prompt 末尾（无论 prompt 来自哪一来源），模型经 load_skill 按需取全文
  const skills = await discoverSkills(workspace, home);
  const skillsSection = formatSkillList(skills);
  const systemPrompt = skillsSection === "" ? promptBase : `${promptBase}\n\n${skillsSection}`;
  registerSkillTool(executor, skills);

  let llm: LLMRequester;
  let model: string;
  if (options.fake) {
    llm = demoScript();
    model = "fake-llm";
  } else {
    const built = await createLLM(config);
    llm = built.llm;
    model = built.model;
    // web 工具复用 LLM 凭证（#3：search/fetch 与 LLM 共用 baseUrl + Bearer）；经 BuiltLLM 显式出口传递
    registerWebTools(executor, built.webCredentials);
    // 生效来源打印（脱敏：只打字段与来源，不打值）；apiKey 兜底来源名按 provider 参数化
    const apiKeyFallback = built.provider === "kimi" ? "kimi-code 订阅 OAuth" : "无（未配置 api_key）";
    process.stderr.write(
      `[config]\n${describeConfigSources(config, apiKeyFallback)}\n  systemPrompt ← ${promptSource}\n`,
    );
  }

  const approvalGate: ApprovalGate | undefined = options.printApproval
    ? createComposedGate({
        bus,
        workspace,
        answerer: createPrintAnswerer(options.printApproval.yes, (message) =>
          process.stderr.write(`${message}\n`),
        ),
        approvalKind: (name) => executor.approvalKind(name),
      })
    : undefined;

  const loop = new Loop({
    llm,
    executor,
    bus,
    sink,
    systemPrompt,
    ...(config.contextBudget !== undefined ? { contextTokenBudget: config.contextBudget } : {}),
    ...(approvalGate ? { approvalGate } : {}),
  });
  if (contextMessages.length > 0) {
    loop.loadHistory(contextMessages);
  }
  // git 感知（#62）：会话开始探测一次脏状态，脏则一句提醒进上下文（TUI/print 两模式通用；
  // 非 git 仓库/探测失败静默跳过）。提醒是纯上下文消息，不进 wire、不弹 UI 帧。
  const dirty = await detectGitDirty(workspace);
  if (dirty !== undefined) {
    loop.injectContext(
      `[workspace] the working tree has ${dirty.count} uncommitted change(s) — treat them as in-flight work ` +
        `and avoid overwriting them (prefer edit_file; re-read before write_file).`,
    );
  }
  return { loop, bus, wire, workspace, approvalKind: (name) => executor.approvalKind(name), model, sessionPath, history, approvalMemory, systemPrompt, skills, todos };
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
