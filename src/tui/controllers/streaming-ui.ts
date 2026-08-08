/**
 * streaming-ui controller：订阅引擎事件流，驱动消息块与 loader。
 * 对齐 kimi-code controllers/streaming-ui.ts 的迷你版：
 * assistant.delta 增量更新当前 Markdown 块；tool.call/result 成帧；
 * 工具调用后的新文本落入新 assistant 块（保持视口顺序 = 事件顺序）。
 *
 * 只依赖 EventBus 契约与 pi-tui 组件，不碰引擎内部（ADR-0001）。
 */
import type { EventBus } from "../../engine/events.ts";
import { type Container } from "../../../vendor/pi-tui/src/index.ts";
import { AssistantMessageComponent } from "../components/messages/assistant-message.ts";
import { errorLine } from "../components/messages/error-line.ts";
import { ThinkingComponent } from "../components/messages/thinking.ts";
import { ToolCallComponent } from "../components/messages/tool-call.ts";
import { ThemedLoader } from "../components/chrome/loader.ts";

export interface StreamingUiDeps {
  bus: EventBus;
  /** 消息列表容器（welcome 在上、editor 在下的中间区）。 */
  chat: Container;
  loader: ThemedLoader;
  requestRender: () => void;
}

export class StreamingUiController {
  private readonly bus: EventBus;
  private readonly chat: Container;
  private readonly loader: ThemedLoader;
  private readonly requestRender: () => void;
  private readonly unsubscribes: Array<() => void> = [];

  private accumulated = "";
  private accumulatedThink = "";
  private currentAssistant: AssistantMessageComponent | undefined;
  private currentThinking: ThinkingComponent | undefined;
  private readonly pendingTools = new Map<string, ToolCallComponent>();

  constructor(deps: StreamingUiDeps) {
    this.bus = deps.bus;
    this.chat = deps.chat;
    this.loader = deps.loader;
    this.requestRender = deps.requestRender;
  }

  start(): void {
    this.unsubscribes.push(
      this.bus.on("turn.started", () => {
        this.accumulated = "";
        this.accumulatedThink = "";
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        this.pendingTools.clear();
        this.loader.start();
        this.requestRender();
      }),
      this.bus.on("assistant.think", ({ text }) => {
        this.accumulatedThink += text;
        if (this.currentThinking === undefined) {
          this.currentThinking = new ThinkingComponent();
          this.chat.addChild(this.currentThinking);
        }
        this.currentThinking.updateContent(this.accumulatedThink);
        this.requestRender();
      }),
      this.bus.on("assistant.delta", ({ text }) => {
        this.loader.hide();
        // 正文开始 = 思考块封版（折叠留在上方，不混进 Markdown 回复）
        this.currentThinking = undefined;
        this.accumulatedThink = "";
        this.accumulated += text;
        if (this.currentAssistant === undefined) {
          this.currentAssistant = new AssistantMessageComponent();
          this.chat.addChild(this.currentAssistant);
        }
        this.currentAssistant.updateContent(this.accumulated);
        this.requestRender();
      }),
      this.bus.on("tool.call", ({ id, name, args }) => {
        this.loader.hide();
        // 当前 assistant/思考块封版：工具帧之后的内容属于新块
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        this.accumulated = "";
        this.accumulatedThink = "";
        const frame = new ToolCallComponent(name, args);
        this.pendingTools.set(id, frame);
        this.chat.addChild(frame);
        this.requestRender();
      }),
      this.bus.on("tool.result", ({ id, ok, output }) => {
        this.pendingTools.get(id)?.setResult(ok, output);
        this.pendingTools.delete(id);
        this.requestRender();
      }),
      this.bus.on("turn.ended", ({ reason, error }) => {
        this.loader.hide();
        this.currentAssistant = undefined;
        this.currentThinking = undefined;
        this.accumulated = "";
        this.accumulatedThink = "";
        if (reason === "error" && error !== undefined) {
          this.chat.addChild(errorLine(error));
        }
        this.requestRender();
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.loader.hide();
  }
}
