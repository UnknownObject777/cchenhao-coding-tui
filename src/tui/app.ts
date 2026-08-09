/**
 * TUI 装配与入口（#18）：把 Engine 接到 pi-tui 组件树上。
 * assembleTui 与终端类型解耦——生产用 ProcessTerminal，测试用 VirtualTerminal。
 * 布局顺序 = addChild 顺序：welcome → chat（消息流）→ loader → footer → editor。
 */
import { bootstrap, type Agent } from "../bootstrap.ts";
import { createComposedGate } from "../engine/approval/composed-gate.ts";
import { SessionStore } from "../engine/session.ts";
import { pickSession } from "./session-picker.ts";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  ProcessTerminal,
  TUI,
} from "../../vendor/pi-tui/src/index.ts";
import { TuiApprovalAnswerer } from "./approval/tui-answerer.ts";
import { builtinCommands } from "./commands/builtins.ts";
import { buildSkillCommands } from "./commands/skills.ts";
import { FooterComponent } from "./components/chrome/footer.ts";
import { createLoader } from "./components/chrome/loader.ts";
import { WelcomeComponent } from "./components/chrome/welcome.ts";
import { AssistantMessageComponent } from "./components/messages/assistant-message.ts";
import { ToolCallComponent } from "./components/messages/tool-call.ts";
import { UserMessageComponent } from "./components/messages/user-message.ts";
import { TOOL_FRAME_TOGGLE_KEY } from "./constant/symbols.ts";
import { StreamingUiController } from "./controllers/streaming-ui.ts";
import { TuiCoordinator } from "./coordinator.ts";
import { detectTerminalTheme } from "./theme/detect.ts";
import { createEditorTheme } from "./theme/pi-tui-theme.ts";
import { currentTheme } from "./theme/theme.ts";

export interface TuiAppInfo {
  toolName: string;
  version: string;
  model: string;
  cwd: string;
  /** 审批模式展示文案（#48 footer；TUI 恒为「审批:交互」，print 无 footer）。 */
  approvalLabel: string;
}

export interface TuiApp {
  tui: TUI;
  editor: Editor;
  streamingUi: StreamingUiController;
  coordinator: TuiCoordinator;
  /** 拆审批输入监听（退出时调用）。 */
  detachApproval: () => void;
  /** 拆 ctrl+o 展开监听（退出时调用）。 */
  detachExpand: () => void;
}

export function assembleTui(
  tui: TUI,
  agent: Agent,
  info: TuiAppInfo,
  onExit: () => void,
): TuiApp {
  const chat = new Container();
  const loader = createLoader(tui);
  // pi-tui Loader 构造即 start（setIndicator → start），初始应隐藏，等 turn.started 再亮相
  loader.hide();
  const editor = new Editor(tui, createEditorTheme());
  // slash 命令补全（#21/#59）：命令声明单源 = builtin 注册表 + 每个 skill 一条 /<skill-name> 动态命令
  const commands = [...builtinCommands(), ...buildSkillCommands(agent.skills)];
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      commands.map((c) => ({ name: c.name, description: c.description })),
      info.cwd,
    ),
  );

  tui.addChild(
    new WelcomeComponent({ toolName: info.toolName, version: info.version, model: info.model, cwd: info.cwd }),
  );
  const footer = new FooterComponent({ model: info.model, cwd: info.cwd, approvalLabel: info.approvalLabel });
  // 恢复会话的 todo 状态预置（#58）：restore 是静默注入，不重发事件，footer 从这里初始化
  if (agent.todos.list().length > 0) {
    footer.setTodos(agent.todos.list());
  }
  tui.addChild(chat);
  tui.addChild(loader);
  tui.addChild(footer);
  tui.addChild(editor);
  tui.setFocus(editor);

  // 会话恢复（#29）：冷重建的历史渲染成静态消息块（展示通道；上下文已在 bootstrap 进 loop）
  for (const message of agent.history) {
    if (message.role === "user") {
      chat.addChild(new UserMessageComponent(message.text));
    } else if (message.role === "assistant") {
      const block = new AssistantMessageComponent();
      block.updateContent(message.text);
      chat.addChild(block);
    } else {
      const frame = new ToolCallComponent(message.name, message.args);
      frame.setResult(message.ok, message.output);
      chat.addChild(frame);
    }
  }

  const streamingUi = new StreamingUiController({
    bus: agent.bus,
    chat,
    loader,
    footer,
    requestRender: () => tui.requestRender(),
  });
  streamingUi.start();

  // 审批（#28）：TUI 应答源 + 规则/记忆组合体，后置注入 loop（应答源依赖组件树）；
  // 恢复会话带上 wire 还原的 always 记忆（#29）
  const answerer = new TuiApprovalAnswerer({ tui, chat });
  const detachApproval = answerer.attach();
  agent.loop.setApprovalGate(
    createComposedGate({
      bus: agent.bus,
      workspace: agent.workspace,
      answerer,
      approvalKind: agent.approvalKind,
      remembered: new Set(agent.approvalMemory),
    }),
  );

  // ctrl+o：折叠/展开最近的工具帧（#24）
  const detachExpand = tui.addInputListener((data: string): { consume: true } | undefined => {
    if (matchesKey(data, TOOL_FRAME_TOGGLE_KEY) && streamingUi.toggleLastToolFrame()) {
      return { consume: true };
    }
    return undefined;
  });

  const coordinator = new TuiCoordinator({ tui, editor, chat, agent, commands, onExit });
  coordinator.start();

  return { tui, editor, streamingUi, coordinator, detachApproval, detachExpand };
}

/** 生产入口：ProcessTerminal + 会话选择器（#47）+ Ctrl+C/退出时恢复 raw mode。 */
export async function runTui(options: {
  workspace: string;
  fake: boolean;
  forceNew: boolean;
  info: Omit<TuiAppInfo, "model" | "cwd">;
}): Promise<void> {
  const tui = new TUI(new ProcessTerminal());
  await tui.start();

  let app: TuiApp;
  const shutdown = (): void => {
    app.detachApproval();
    app.detachExpand();
    app.streamingUi.stop();
    app.coordinator.stop();
    app.tui.stop();
    process.exit(0);
  };
  // 装配完成前的退出/失败路径：恢复 raw mode 再退出
  const earlyExit = (): void => {
    tui.stop();
    process.exit(0);
  };

  try {
    // 会话选择（#47）：有历史会话且未 --new 时先问
    const store = new SessionStore(SessionStore.defaultRoot(), options.workspace);
    const sessions = options.forceNew ? [] : await store.list();
    const choice =
      sessions.length === 0 ? { kind: "new" as const } : await pickSession(tui, sessions, earlyExit);

    const agent = await bootstrap({
      workspace: options.workspace,
      fake: options.fake,
      session: choice.kind === "resume" ? { resume: choice.path } : "new",
    });

    app = assembleTui(tui, agent, { ...options.info, model: agent.model, cwd: options.workspace }, shutdown);
  } catch (error) {
    // bootstrap 失败（如无凭证）不能留 raw mode 卡死终端
    tui.stop();
    throw error;
  }

  // 启动后检测终端背景（#23）：亮背景切亮色 palette，失败安全降级 dark
  const detected = await detectTerminalTheme(app.tui);
  if (detected !== currentTheme.current) {
    currentTheme.setTheme(detected);
    app.tui.requestRender(true);
  }
}
