/**
 * 协调器（类比 kimi-code 的 kimi-tui.ts，薄）：
 * 输入路由（slash 命令 or 引擎 turn）、turn 期间禁止重复提交、Ctrl+C 干净退出。
 * 装配（组件上树、事件订阅）在 bootstrap 侧，这里只拿现成的部件。
 */
import type { Agent } from "../bootstrap.ts";
import {
  matchesKey,
  Text,
  type Container,
  type Editor,
  type TUI,
} from "../../vendor/pi-tui/src/index.ts";
import { builtinCommands } from "./commands/builtins.ts";
import { parseSlashCommand } from "./commands/parse.ts";
import type { SlashCommandContext, SlashCommandDefinition } from "./commands/types.ts";
import { UserMessageComponent } from "./components/messages/user-message.ts";
import { hex } from "./theme/pi-tui-theme.ts";

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
    const parsed = parseSlashCommand(text);
    if (parsed !== undefined) {
      await this.executeSlash(parsed.name);
      return;
    }
    if (this.busy) return;

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
      this.deps.chat.addChild(new Text(hex("error")(`unknown command: /${name}`), 0, 0));
      this.deps.tui.requestRender();
      return;
    }
    await command.execute(this.commandContext());
    this.deps.tui.requestRender();
  }

  private commandContext(): SlashCommandContext {
    return {
      clearConversation: () => {
        this.deps.chat.clear();
        this.deps.agent.loop.reset();
      },
      deleteSession: async () => {
        this.deps.chat.clear();
        this.deps.agent.loop.reset();
        await this.deps.agent.wire.clear();
      },
    };
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.deps.editor.disableSubmit = busy;
  }
}
