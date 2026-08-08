/**
 * TUI 装配与入口（#18）：把 Engine 接到 pi-tui 组件树上。
 * assembleTui 与终端类型解耦——生产用 ProcessTerminal，测试用 VirtualTerminal。
 * 布局顺序 = addChild 顺序：welcome → chat（消息流）→ loader → footer → editor。
 */
import type { Agent } from "../bootstrap.ts";
import { createComposedGate } from "../engine/approval/composed-gate.ts";
import {
  Container,
  Editor,
  ProcessTerminal,
  TUI,
} from "../../vendor/pi-tui/src/index.ts";
import { TuiApprovalAnswerer } from "./approval/tui-answerer.ts";
import { FooterComponent } from "./components/chrome/footer.ts";
import { createLoader } from "./components/chrome/loader.ts";
import { WelcomeComponent } from "./components/chrome/welcome.ts";
import { StreamingUiController } from "./controllers/streaming-ui.ts";
import { TuiCoordinator } from "./coordinator.ts";
import { createEditorTheme } from "./theme/pi-tui-theme.ts";

export interface TuiAppInfo {
  toolName: string;
  version: string;
  model: string;
  cwd: string;
}

export interface TuiApp {
  tui: TUI;
  editor: Editor;
  streamingUi: StreamingUiController;
  coordinator: TuiCoordinator;
  /** 拆审批输入监听（退出时调用）。 */
  detachApproval: () => void;
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

  tui.addChild(
    new WelcomeComponent({ toolName: info.toolName, version: info.version, model: info.model, cwd: info.cwd }),
  );
  tui.addChild(chat);
  tui.addChild(loader);
  tui.addChild(new FooterComponent({ model: info.model, cwd: info.cwd }));
  tui.addChild(editor);
  tui.setFocus(editor);

  const streamingUi = new StreamingUiController({
    bus: agent.bus,
    chat,
    loader,
    requestRender: () => tui.requestRender(),
  });
  streamingUi.start();

  // 审批（#28）：TUI 应答源 + 规则/记忆组合体，后置注入 loop（应答源依赖组件树）
  const answerer = new TuiApprovalAnswerer({ tui, chat });
  const detachApproval = answerer.attach();
  agent.loop.setApprovalGate(createComposedGate({ bus: agent.bus, workspace: agent.workspace, answerer }));

  const coordinator = new TuiCoordinator({ tui, editor, chat, agent, onExit });
  coordinator.start();

  return { tui, editor, streamingUi, coordinator, detachApproval };
}

/** 生产入口：ProcessTerminal + Ctrl+C/退出时恢复 raw mode。 */
export async function runTui(agent: Agent, info: TuiAppInfo): Promise<void> {
  let app: TuiApp;
  app = assembleTui(new TUI(new ProcessTerminal()), agent, info, () => {
    app.detachApproval();
    app.streamingUi.stop();
    app.coordinator.stop();
    app.tui.stop();
    process.exit(0);
  });
  await app.tui.start();
}
