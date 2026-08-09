/**
 * 协调器（类比 kimi-code 的 kimi-tui.ts，薄）：
 * 输入路由（slash 命令 or 引擎 turn）、turn 期间禁止提交、Ctrl+C 拦截转 onExit。
 * 组件上树的装配在 #18 的 bootstrap；editor.onSubmit 与 bus 订阅由本类的 start() 接线。
 */
import type { EventBus } from "../engine/events.ts";
import type { Loop } from "../engine/loop.ts";
import { formatSkillInvocation, skillBody, type Skill } from "../engine/skills.ts";
import { errorMessage } from "../engine/tools/executor.ts";
import type { WireService } from "../engine/wire.ts";
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

/** coordinator 需要的引擎能力面（窄接口，结构类型；bootstrap.Agent 天然满足）。 */
export interface CoordinatorAgent {
  bus: EventBus;
  loop: Pick<Loop, "runTurn" | "reset" | "compact" | "injectContext">;
  wire: Pick<WireService, "clear">;
  /** 发现的 skills（#59）：/<skill-name> 命令与注入查表。 */
  skills: Skill[];
}

export interface CoordinatorDeps {
  tui: TUI;
  editor: Editor;
  chat: Container;
  agent: CoordinatorAgent;
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
    // 任何「不可提交窗口」（turn 进行中、slash 执行中）一切提交都忽略：
    // /clear /delete 会清 transcript/wire，与流式更新和 append 队列竞争
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
    // slash 执行期同样置 busy：/delete 的 wire.clear() 在飞时若放行新 turn，
    // append 会与 rm 竞态（busy 闸必须双向）
    this.setBusy(true);
    try {
      await command.execute(this.commandContext());
    } finally {
      this.setBusy(false);
    }
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
      // /compact：只缩引擎上下文，transcript 原样保留；反馈靠下一轮 footer 用量回落
      compactContext: async () => {
        await this.deps.agent.loop.compact();
      },
      // /<skill-name>（#59）：人等价触发 load_skill——读全文、剥 frontmatter、注入上下文。
      // 注入形状与 load_skill 工具回灌一致（formatSkillInvocation），模型体验无差别。
      invokeSkill: async (name: string) => {
        const skill = this.deps.agent.skills.find((s) => s.name === name);
        if (skill === undefined) {
          this.deps.chat.addChild(errorLine(`unknown skill: ${name}`));
          this.deps.tui.requestRender();
          return;
        }
        try {
          const body = await skillBody(skill);
          this.deps.agent.loop.injectContext(formatSkillInvocation(skill.name, skill.path, body));
        } catch (error) {
          this.deps.chat.addChild(errorLine(`skill ${name} 加载失败：${errorMessage(error)}`));
          this.deps.tui.requestRender();
        }
      },
    };
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.deps.editor.disableSubmit = busy;
  }
}
