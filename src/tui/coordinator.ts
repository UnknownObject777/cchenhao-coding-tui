/**
 * 协调器（类比 kimi-code 的 kimi-tui.ts，薄）：
 * 输入路由（slash 命令 or 引擎 turn）、turn 期间禁止提交、Ctrl+C 拦截转 onExit。
 * 组件上树的装配在 #18 的 bootstrap；editor.onSubmit 与 bus 订阅由本类的 start() 接线。
 */
import type { Agent } from "../bootstrap.ts";
import {
  matchesKey,
  type Container,
  type Editor,
  type TUI,
} from "../../vendor/pi-tui/src/index.ts";
import { builtinCommands } from "./commands/builtins.ts";
import { parseSlashCommand } from "./commands/parse.ts";
import type { SlashCommandContext, SlashCommandDefinition } from "./commands/types.ts";
import { errorLine } from "./components/messages/error-line.ts";
import { UserMessageComponent } from "./components/messages/user-message.ts";

export interface CoordinatorDeps {
  tui: TUI;
  editor: Editor;
  chat: Container;
  agent: Agent;
  /** 默认 builtinCommands()；测试可注入。 */
  commands?: SlashCommandDefinition[];
  onExit: () => void;
}

export class TuiCoordinator {
  private readonly deps: CoordinatorDeps;
  private readonly commands: SlashCommandDefinition[];
  private readonly unsubscribes: Array<() => void> = [];
  private busy = false;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.commands = deps.commands ?? builtinCommands();
  }

  start(): void {
    this.deps.editor.onSubmit = (text: string) => {
      void this.handleSubmit(text);
    };

    // raw mode 下 Ctrl+C 不发 SIGINT，须自拦（inputListener 先于聚焦组件收到输入）
    this.unsubscribes.push(
      this.deps.tui.addInputListener((data) => {
        if (matchesKey(data, "ctrl+c")) {
          this.deps.onExit();
          return { consume: true };
        }
        return undefined;
      }),
    );

    this.unsubscribes.push(
      this.deps.agent.bus.on("turn.ended", () => {
        this.setBusy(false);
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  /** 测试与 editor.onSubmit 共用的入口。 */
  async handleSubmit(text: string): Promise<void> {
    // turn 进行中一切提交都忽略（含 slash）：/clear /delete 会清 transcript/wire，
    // 与流式更新和 append 队列竞争
    if (this.busy) return;

    const parsed = parseSlashCommand(text);
    if (parsed !== undefined) {
      await this.executeSlash(parsed.name);
      return;
    }

    this.setBusy(true);
    this.deps.chat.addChild(new UserMessageComponent(text));
    this.deps.tui.requestRender();
    try {
      await this.deps.agent.loop.runTurn(text);
    } finally {
      // 正常路径由 turn.ended 事件复位；这里兜底 runTurn 抛错/未发事件的意外
      this.setBusy(false);
    }
  }

  private async executeSlash(name: string): Promise<void> {
    const command = this.commands.find((c) => c.name === name);
    if (command === undefined) {
      this.deps.chat.addChild(errorLine(`unknown command: /${name}`));
      this.deps.tui.requestRender();
      return;
    }
    await command.execute(this.commandContext());
    this.deps.tui.requestRender();
  }

  private commandContext(): SlashCommandContext {
    const clearConversation = () => {
      this.deps.chat.clear();
      this.deps.agent.loop.reset();
    };
    return {
      clearConversation,
      deleteSession: async () => {
        clearConversation();
        await this.deps.agent.wire.clear();
      },
    };
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.deps.editor.disableSubmit = busy;
  }
}
