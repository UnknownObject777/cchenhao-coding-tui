---
tags:
  - kimi-code
  - spec
  - pi-tui
  - 玩具项目
---

# Spec · 迷你 Coding Agent 玩具（pi-tui）

> 目标：用 `@moonshot-ai/pi-tui` 写一个极简 coding agent 聊天终端应用，**照搬 kimi-code 的 TUI 架构分层**（KimiTUI 协调器 / controllers / components / theme / streaming-ui 模式），但引擎部分**自写迷你版**（loop / llmRequester / toolExecutor / wire）。用最小的代码把"一个 agent 是怎么跑起来的 + 真实产品的 TUI 是怎么组织的"同时落到手。
> 依据：kimi-code 的 TUI 本身就是基于 pi-tui 的（见 [[包依赖图]]：`apps/kimi-code` 是 `@moonshot-ai/pi-tui` 的消费者），所以"照搬架构"不是重新发明，而是学它的组织方式。

## Problem Statement

已经五节课读懂了 kimi-code 的架构（[[学习目标]] 全部达成），但**从未动过手**：没写过一行引擎代码、没跑过测试、没有把"loop 驱动 LLM 流 + 工具回灌 + 事件驱动渲染"这套概念变成可运行的程序。本仓库太大（`agent-core-v2` 782 个源码文件、`apps/kimi-code/src/tui` 上百个文件），不适合作为第一块上手板。需要一个能把概念落到代码、能在两天内跑通、还能用真实测试验证的小项目，同时这个小项目要**长着跟 kimi-code 一样的骨架**，让学过的分层知识直接迁移。

## Solution

用 `@moonshot-ai/pi-tui` 写一个**迷你 coding agent 终端应用**，分两大块：

- **引擎（Engine）**：极简 loop——消费 LLM 的异步事件流、把 tool call 交给 tool executor 执行、把结果回灌上下文再继续，直到 turn 结束；全部事件按序列追加到一份 wire 日志（JSONL），进程重启后可从日志冷重建对话。
- **TUI（照搬 kimi-code 分层）**：不写成一个 main.ts 大杂烩，而是按 kimi-code `apps/kimi-code/src/tui/` 的骨架组织——协调器 + controllers + components（按 UI 类型分子目录）+ theme + 事件处理器。

```
┌─ Engine（零 TUI 依赖，可 headless 测）─────────────────────────────┐
│  Loop（turn 状态机 + 事件发布）                                     │
│    ├── LLMRequester  消费 AsyncIterable 流（真实 provider 或 fake）  │
│    ├── ToolExecutor  工具注册表 + 执行 + 结果回灌上下文              │
│    └── WireService   事件序列 append-only 落盘（wire.jsonl）+ 冷重建  │
└──────────────┬──────────────────────────────────────────────────┘
               │ 事件（EventBus 类型契约）
┌──────────────┴──────────────────────────────────────────────────┐
│ TUI（照搬 kimi-code 分层）                                        │
│  Coordinator（KimiTUI 类比）→ 装配 state / 布局 / 引擎事件 / 输入   │
│  controllers/          → 事件路由、流式渲染、slash 命令解析         │
│  components/           → chrome/（footer、loader）、messages/（消息块│
│                          、工具帧）、editor/（输入框）              │
│  theme/                → 颜色 token + pi-tui markdown 主题         │
└─────────────────────────────────────────────────────────────────┘
```

**关键认知**：引擎负责"算"，TUI 负责"演"；TUI 只消费事件、不碰引擎内部状态——这正是 [[端到端旅程：一条消息从终端到模型再回来]] 里"引擎是唯一事实源、UI 是投影"的最小复刻。

## User Stories

1. 作为一个想动手的用户，我希望 `pnpm dev` 一个命令启动终端应用，这样不用配置任何工程就能看到界面。
2. 作为一个用户，我希望能看到欢迎信息和一个底部输入框，这样我知道该在哪里打字。
3. 作为一个用户，我希望在底部 Editor 输入多行文本并按 Enter 提交，这样我能发送复杂的请求。
4. 作为一个用户，我希望我发出的消息以 Markdown 块立即显示在消息区上方，这样我能看到自己的输入。
5. 作为一个用户，我希望 agent 回复期间显示一个转动的 Loader，这样我知道它在思考而不是卡死。
6. 作为一个用户，我希望 agent 的回复逐段流式显示而不是一次蹦出，这样我能看到真实的生成过程。
7. 作为一个用户，我希望回复内容按 Markdown 渲染（代码块、粗体、列表），这样贴合 coding agent 的阅读习惯。
8. 作为一个用户，我希望在 agent 回复期间禁止再次提交，这样不会造成并发 turn 混乱。
9. 作为一个用户，我希望支持 `/clear` 清空消息区，这样界面不会无限堆积。
10. 作为一个用户，我希望支持 `/delete` 删除最后一条消息，这样能快速纠正误操作。
11. 作为一个用户，我希望按 Ctrl+C 干净退出应用，这样不会留下终端处于 raw mode 的残留状态。
12. 作为一个用户，我希望 agent 能调用内置工具（如读文件、执行命令、查看工作区文件），这样它是一个"coding" agent 而不是纯聊天。
13. 作为一个用户，我希望工具调用在我的对话里显示为一个独立的工具帧（显示工具名、参数、结果摘要），这样我能看到 agent 在做什么。
14. 作为一个用户，我希望工具执行结果能回灌给模型并影响后续回复，这样 agent 能基于真实文件内容作答。
15. 作为一个用户，我希望每个完整问答回合构成一个 turn，并在界面上有清晰的视觉边界，这样我能理解 agent 的行为节奏。
16. 作为一个用户，我希望全部引擎事件（prompt / delta / tool.call / tool.result / turn.ended）按序列追加到 wire.jsonl，这样对话可持久化。
17. 作为一个用户，我希望重启应用后能从 wire.jsonl 冷重建之前的对话，这样进程退出不丢历史。
18. 作为一个用户，我希望能通过环境变量切换用 fake LLM（预置脚本）或真实 LLM API，这样没有 key 也能演示，有 key 也能真跑。
19. 作为一个开发者，我希望 loop 的核心逻辑不依赖任何 TUI 代码，这样能在 headless 下测试事件序列。
20. 作为一个开发者，我希望引擎与 UI 之间只通过事件总线通信，这样我可以单独验证引擎行为而不开终端。
21. 作为一个开发者，我希望 TUI 层的文件组织与 kimi-code 的 `src/tui/` 同构（协调器/controllers/components/theme），这样我学到的分层知识能直接迁移到真实仓库。
22. 作为一个开发者，我希望流式渲染逻辑从协调器里独立出来放进专门的 controller（类比 kimi-code 的 `streaming-ui.ts`），这样协调器不会膨胀、渲染逻辑可独立测试。
23. 作为一个开发者，我希望颜色都从 theme 模块取、不散落 chalk 命名色（类比 kimi-code 的 theme 单源约束），这样换主题只改一处。
24. 作为一个开发者，我希望 slash 命令的声明/解析与执行分离（类比 kimi-code 的 `commands/` 目录），这样加新命令只加一处声明。

## Implementation Decisions

### 模块划分（全部新建，单进程）

**引擎模块（Engine，无任何 TUI 依赖）**

- `Loop`：turn 状态机。接收用户输入 → 组装 messages → 消费 LLM 流 → 对每个 event 发布对应领域事件 → 收到 `tool_call` 时暂停、交给 executor、结果回灌 → 直到 finish → 发 `turn.ended`。
- `LLMRequester`（接口 + 实现）：暴露 `request(messages, tools): AsyncIterable<ModelEvent>`；`ModelEvent` 判别联合为 `text` / `think` / `tool_call` / `finish`。一个 **fake 实现**（读脚本流、含预置 tool call）用于无 key 演示与测试；一个 **真实实现** 接 Kimi/OpenAI 兼容端点。
- `ToolExecutor`：`register(name, definition)` 注册表 + `execute(name, args)` 执行 + 结果对象。内置三个玩具工具：`read_file`（读工作区文件）、`write_file`（写工作区文件）与 `run_command`（执行 shell 命令，超时保护）。未注册工具返回结构化错误结果而非抛错（让模型有机会自纠正）。
- `EventBus`：极简类型化事件发布/订阅（`on(event, cb)` / `emit`），引擎与 UI 的唯一通信通道；事件类型定义放引擎侧。
- `WireService`：把事件按序列 append 到 `wire.jsonl`（每行 JSON，带 `seq`），并提供 `readAll()` 供冷重建。这是对 kimi-code `wire` 概念的最小致敬——**只做追加，不做检查点**。
- `Rebuilder`：读 wire.jsonl 按 seq 折叠出消息列表，实现冷会话重建。

**TUI 模块（照搬 kimi-code `apps/kimi-code/src/tui/` 的分层，只保留玩具需要的子集）**

- **Coordinator**（类比 `kimi-tui.ts`）：一个协调器类，负责装配 state、布局（消息区 + 底部 Editor）、引擎事件订阅、输入入口与 slash 命令分发。它**不做**具体渲染与事件路由逻辑——那些下沉到 controllers。
- **controllers/**（类比 `controllers/`）：
  - `session-event-handler.ts`（类比）——把 EventBus 事件路由到 UI：`assistant.delta` → 流式更新、`tool.call`/`tool.result` → 工具帧、`turn.ended` → 收尾。
  - `streaming-ui.ts`（类比）——流式渲染：当前 assistant Markdown 块的增量更新、loader 的启停。
- **components/**（类比 `components/`，按 UI 类型分子目录）：
  - `chrome/` —— footer（状态栏）、loader、welcome 文本。
  - `messages/` —— `user-message.ts`、`assistant-message.ts`、`tool-call.ts`（工具帧）各一个消息块组件。
  - `editor/` —— 底部输入框（用 pi-tui `Editor` + `CombinedAutocompleteProvider` 做 `/clear` `/delete`）。
- **theme/**（类比 `theme/`）：颜色 token（`colors.ts`）+ pi-tui markdown 主题（`pi-tui-theme.ts`），作为颜色唯一来源；组件不用 chalk 命名色，只经 theme 取色。
- **utils/**：TUI 专用小工具（如需 width 截断封装）。
- Ctrl+C 拦截退出（pi-tui raw mode 下 SIGINT 不会自动送达）。

**入口模块**：`bootstrap()` 装配 Engine → TUI，环境变量 `FAKE_LLM=1` 或 `KIMI_API_KEY` 决定 LLM 实现；装配点是"组合根"的显式致敬。

### 技术澄清

- **真实 LLM 实现只做 HTTP 拉取，不做 stream 之外的高级能力**：不处理工具协议细节、不重试、不鉴权重刷新，够用即可——超出范围直接抛错，保持玩具诚实。
- **事件契约是核心**：UI 只认事件不认引擎内部状态；controllers 只做"事件 → 组件更新"，组件不反向触碰引擎。
- **tool_call 流回灌**：fake 与真实实现都按"模型流先吐出 tool_call → executor 执行 → 结果作为 tool 角色消息再喂一轮"的顺序驱动，与 kimi-code 的 loop→toolExecutor→promptService 循环同构。
- **wire 的 seq 单调递增**，每行一个事件；冷重建不追求无损，只恢复消息与工具帧的大致顺序（对齐"持久化是唯一事实源、UI 是投影"的认知）。
- **TUI 只做"照搬组织方式"，不做"照搬全部代码"**：controllers 只保留事件路由 + 流式渲染两个；components 只保留 chrome/messages/editor 三类；theme 只保留 token + markdown 主题。砍到能徒手写完的规模，但目录形状与职责边界严格对齐 kimi-code。
- 项目结构从零新建，**不改仓库内任何现有包**；`@moonshot-ai/pi-tui` 只作为依赖被消费，不 fork 不修改。

### 架构决策

- **引擎零依赖 TUI**：`EventBus` 的事件类型定义放引擎侧，UI 只 import 类型。这是最高优先级的决策，直接支撑"headless 可测"。
- **TUI 分层照搬 kimi-code**：协调器薄、controllers 独立、components 按 UI 类型分、theme 单源。这是本 spec 与"从零发明"方案的核心区别。
- **三接缝测试**：① loop 事件序列（fake LLM 驱动，断言事件顺序）② tool executor（注册表 + 回灌）③ wire 持久化（append + 冷重建往返）。
- **命名与术语沿用 kimi-code**：`turn` / `loop` / `wire` / `tool call` / `tool.result` / `streaming-ui` / `theme`，不发明新词，强化术语迁移（见 [[术语表]]）。

## Testing Decisions

**好测试的标准**：只测外部行为（事件序列、持久化往返、工具回灌结果、UI 视口内容），不测实现细节（不 assert 内部字段、不 mock 引擎私有状态）。

- **模块**：`loop`、`toolExecutor`、`wire` 三块有单元测试；TUI 的 `streaming-ui` / 消息块组件用 pi-tui 的 `VirtualTerminal` 做行为测试；协调器做一个冒烟测试（提交一条消息 → 期望消息区出现用户块 + 回复块）。
- **先例**：pi-tui 自带测试底座 `VirtualTerminal`（`@xterm/headless` 仿真终端，`test/virtual-terminal.ts`），本玩具复用它做 UI 断言；引擎测试完全 headless，不碰终端。kimi-code 的 `apps/kimi-code/test/tui/` 是"controller 可独立测试"这一组织方式的第一手先例。
- **测试类型**
  - loop：fake LLM 流（先 text delta、再 tool_call、再 finish）→ 断言事件发布顺序 `turn.started → assistant.delta → tool.call → tool.result → assistant.delta → turn.ended`。
  - toolExecutor：注册一个假工具 → 执行 → 断言参数透传与结果形状；未注册工具 → 断言抛错。
  - wire：写一串事件 → 读回 → 断言逐条相等且 seq 连续；追加到已有文件不丢旧事件。
  - streaming-ui：给 controller 喂一组事件 → 断言它产出的组件更新序列正确（delta 累积、loader 启停）。
  - UI 冒烟：VirtualTerminal 下 `tui.start()` → `sendInput` 提交 → flush → 断言视口包含用户文本与 loader→回复文本。
- **不测**：真实 LLM 的 HTTP 交互（网络依赖，玩具不做集成测试）；pi-tui 自身的渲染正确性（那是 pi-tui 的职责，已有 `pnpm --filter @moonshot-ai/pi-tui test`）。

## Out of Scope

- 不改 kimi-code 仓库里的任何现有包（pi-tui 只当依赖用）。
- 不做 DI×Scope / Service / Fiber / cascade 事务（那套复杂度是学习目标，不是玩具目标；玩具用显式装配点明"组合根"概念即可）。
- 不做 transcript 包的 op-batch 序列契约、断线补拉、权限审批 UI、reverse-rpc（kimi-code 特有的复杂度，玩具的审批/提问用最简事件代替）。
- 不做多 agent / subagent / swarm。
- 不做上下文压缩（context compaction）、对话撤销（undo）。
- 不做真实 LLM 的工具协议细节、鉴权刷新、重试、流式背压。
- 不做搜索索引、minidb、持久化检查点（只做 append-only wire）。
- TUI 层不照搬 kimi-code 的 dialogs/panes/media/reverse-rpc/commands 全量目录——只保留 chrome/messages/editor/theme/utils 这几个玩具需要的子集。
- 不写 CI、不发布 npm 包、不配 monorepo（独立小型工程即可）。

## Further Notes

- 定位是"第一块上手板 + 架构对照物"：TUI 骨架长成 kimi-code 的样子，引擎把 loop/tool/wire 概念落成几百行代码；之后再读真实 `apps/kimi-code/src/tui/` 时，每个目录都是见过的形状。
- 完成后再看 [[DI×Scope 架构]] 会觉得 DI 层只是给这同一套结构加了生命周期管理；再看 [[端到端旅程：一条消息从终端到模型再回来]] 会觉得真实仓库只是把这条链路换成了 SDK + 服务端。
- 进度建议：先引擎（loop + fake LLM + wire）→ 测试 → 再 TUI 分层骨架（coordinator + controllers + components + theme）→ 接流式渲染 → 冒烟测试 → 最后接真实 LLM。
- 相关笔记：[[端到端旅程：一条消息从终端到模型再回来]] · [[传输与转录流：WS-SSE-REST 与 delta-loop-event]] · [[术语表]] · [[包依赖图]]
