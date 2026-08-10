# 调研：业界 Coding Agent 的 Subagent / Task 设计

- 状态：完成（wayfinder:research，issue #66）
- 日期：2026-08-10
- 范围：Claude Code（Task/Agent tool）、OpenAI Codex CLI、Aider、OpenHands
- 目的：为本项目的 goal + subagent 能力与「git worktree 隔离 + 区内放行/出区必批」自进化笼子提供设计依据

## 一、结论先行

业界 coding agent 的 subagent 设计高度收敛到同一个核心机制，四个产品可以归为三种范式：

1. **同进程内的「子会话」委派**（Claude Code 的 Agent/Task tool）：subagent 是主会话内另起的、拥有**独立上下文窗口**的 agent 循环，与主 agent 共享进程与文件系统；**只有最终结果（summary）回传父 agent**，中间过程全部留在子会话。并行靠「一条消息里发多个 Agent 调用」实现并发 fan-out。隔离升级靠 `git worktree`（可选）而非进程/容器。
2. **模型驱动的并行 subagent workflow**（OpenAI Codex CLI）：spawn 必须**显式触发**（用户或 AGENTS.md/技能指令点名），宿主负责编排（spawn → 等待全部完成 → 合成响应），沙箱策略由父继承、可逐 agent 覆盖。CLI 侧无原生 git worktree 隔离（那是桌面 App 的能力）。
3. **事件流 + 委派 action**（OpenHands）：所有 agent-环境交互是 append-only 的 typed event，委派是一种特殊 action/tool（`AgentDelegateAction` / spawn-delegate 两段式），subagent 独立对话上下文、工具集由定义裁剪，**线程并行执行、合并成一个 observation 回传**，执行隔离靠 Docker 容器沙箱。
4. **无 subagent**（Aider）：单 agent 循环 + 双模型流水线（architect/editor），上下文不隔离；并行靠用户手动开多个实例；安全靠 git 自动提交回滚。它用「git 即安全网」替代了「上下文隔离 + 权限分层」。

**跨产品共识**（可作为本项目最小可行设计的清单）：

- 上下文隔离：subagent 独立 context，只回传结果/摘要，中间输出不污染父上下文；
- 工具集裁剪：allowlist（`tools`）与黑名单（`disallowedTools`）双机制，内置 read-only 探索/规划角色；
- 自定义 agent 用文件声明（Markdown frontmatter / TOML），`description` 同时充当路由提示词；
- 权限：subagent 可声明自己的权限模式，但**父级更宽的模式优先**（权限覆盖单向）；
- 并行：fan-out 模式——同一轮并发 spawn 多个 subagent，父 agent 等全部完成后合成；普遍有并发上限；
- 嵌套：**业界主流不支持或默认单层**（subagent 不能再 spawn subagent、subagent 间不能直接通信）；
- 结果回传：统一由模型/宿主把子结果合并成结构化摘要进入父上下文。

## 二、Claude Code：Task / Agent tool

### 2.1 机制与上下文隔离

- 委派工具名为 **Agent tool**（`AgentTool.tsx`），`Task` 是其历史别名。模型用一个结构化输入调用它：委派 prompt、可选的 subagent 类型、隔离模式、权限覆盖、工作目录等字段按 feature flag 门控（[The Design Space of Today's and Future AI Agent Systems（arXiv 2604.14228）](https://arxiv.org/html/2604.14228v1)）。
- subagent 与主 agent **同一 OS 进程**：Bash 子进程的 PPID 与父会话一致，无进程隔离（[anthropics/claude-code issue #74417](https://github.com/anthropics/claude-code/issues/74417)）。
- 每个 subagent 有**独立上下文窗口**，从零开始：不带主会话对话历史，只带自己的 system prompt、委派消息、CLAUDE.md 与预加载技能；内置 Explore/Plan 连 CLAUDE.md 与 git status 都跳过以省钱（[Shiplight：Claude Code Subagents](https://www.shiplight.ai/blog/claude-code-subagents)）。
- 子会话的完整对话单独存为 **sidechain transcript**（独立文件），防止 subagent 内容膨胀父上下文；父 agent 只拿到子会话的**总结性返回**（[arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)）。
- `isolation` 支持多档：**worktree**（临时 git worktree，subagent 在自己的仓库副本上改，不影响父工作树）、**remote**（内部功能，后台跑在 Claude Code Remote 环境）、**in-process**（默认，共享文件系统但隔离对话上下文）（[arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)）。
- 例外：`/subtask` fork 出的 subagent 继承完整对话（fork 是「分叉会话」，不是默认委派路径）。

### 2.2 工具集裁剪

- 自定义 subagent 是 `.claude/agents/*.md`（项目级，入库）或 `~/.claude/agents/*.md`（个人级），YAML frontmatter + Markdown 正文，正文即 subagent 的 system prompt（[官方文档 Sub-agents](https://code.claude.com/docs/en/sub-agents)；[Shiplight](https://www.shiplight.ai/blog/claude-code-subagents)）。
- 关键 frontmatter 字段：`name`、`description`（必须；兼作路由提示词）、`tools`（allowlist，省略则继承）、`disallowedTools`（黑名单）、`model`（sonnet/opus/haiku/完整模型 ID/inherit）、`permissionMode`、`mcpServers`、`hooks`、`memory`、`background`、`isolation: worktree`（[Shiplight](https://www.shiplight.ai/blog/claude-code-subagents)）。
- 内置类型：**Explore**（read-only，Write/Edit 被禁）、**Plan**（read-only，plan mode 的研究 agent）、**general-purpose**（继承主会话模型 + 全量子工具集）；另有随 feature flag 出现的额外类型（[arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)；[Shiplight](https://www.shiplight.ai/blog/claude-code-subagents)）。
- Explore/Plan 一次性使用（不返回 agent id，不可恢复），其他可 `resume`（[Shiplight](https://www.shiplight.ai/blog/claude-code-subagents)）。

### 2.3 权限与嵌套

- subagent 可声明 `permissionMode`，但**父会话更宽的模式（bypassPermissions / acceptEdits / auto）总是优先**，因为它们代表用户显式的安全/自主权衡；async（后台）agent 默认不弹权限提示，bubble 模式会把子会话的提示冒泡到父终端（[arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)）。
- **不支持嵌套**：subagent 不能再 spawn subagent，subagent 之间不能通信（[joinleland：Claude Code Subagents vs. Agents](https://www.joinleland.com/library/a/claude-subagents)；[hidekazu-konishi 编排指南](https://hidekazu-konishi.com/entry/claude_code_subagents_and_orchestration_guide.html)）。

### 2.4 并行与后台

- **并行**：一条消息里发多个 Agent tool 调用即并发执行，各自独立上下文、独立回传（[Layer3：Claude Code Subagents](https://www.layer3labs.io/guides/claude-code-subagents-explained)；[loop-engineer docs](https://github.com/vibhasdutta/loop-engineer/blob/main/docs/how-it-works.md)）。
- **后台**：`run_in_background: true` 让 subagent 在后台跑，完成时以通知形式回到主会话；可用 Ctrl+B 把前台任务转后台；后台 subagent 的工具集比前台小（[Shiplight](https://www.shiplight.ai/blog/claude-code-subagents)）。
- 更高阶并行是**独立会话**而非子会话：agent teams（实验性，团队负责人编排多个可互相通信、共享文件系统的独立 Claude 会话）与 dynamic workflows（模型生成 JS 编排脚本，由外部 runtime 执行，状态在脚本变量而非模型上下文里）（[samuelfaj：Subagent fan-out for code migrations](https://www.samuelfaj.com/en/blog/subagent-fan-out-for-large-code-migrations/)）。

### 2.5 来源

- 官方：Sub-agents（https://code.claude.com/docs/en/sub-agents）、Run agents in parallel（https://code.claude.com/docs/en/agents）、Agent Teams（https://code.claude.com/docs/en/agent-teams）
- 架构剖析：[The Design Space of Today's and Future AI Agent Systems（arXiv:2604.14228）](https://arxiv.org/html/2604.14228v1)（基于公开源码 v2.1.88 逐文件分析）
- 机制细节：[Shiplight：Claude Code Subagents](https://www.shiplight.ai/blog/claude-code-subagents)、[joinleland](https://www.joinleland.com/library/a/claude-subagents)、[hidekazu-konishi](https://hidekazu-konishi.com/entry/claude_code_subagents_and_orchestration_guide.html)、[Layer3](https://www.layer3labs.io/guides/claude-code-subagents-explained)
- 进程无隔离证据：[anthropics/claude-code#74417](https://github.com/anthropics/claude-code/issues/74417)

## 三、OpenAI Codex CLI：subagent workflows

### 3.1 机制与触发

- Codex 的 multi-agent（subagent workflow）默认启用（`agents.enabled` 默认 true）；**subagent 只在显式要求时 spawn**——用户直接说 "spawn two agents / delegate this work in parallel"，或 AGENTS.md / skill 指令点名（[官方文档 Subagents](https://developers.openai.com/codex/subagents)）。
- 动机与 Claude Code 相同：context pollution（有用信息被噪声淹没）与 context rot（上下文填满后性能下降）——把探索、测试、日志分析等噪声工作移出主线程，subagent 回传**摘要而非原始中间输出**（[官方文档](https://developers.openai.com/codex/subagents)）。
- 宿主负责编排：spawn、路由 follow-up 指令、等待结果、关闭 agent thread；多个 subagent 并发跑时等**全部完成后返回合并响应**（[官方文档](https://developers.openai.com/codex/subagents)）。

### 3.2 上下文、工具与沙箱

- 每个 subagent 是独立会话上下文（agent thread），可打开查看进度与回传的 summary（[官方文档](https://developers.openai.com/codex/subagents)）。
- 自定义 agent：`~/.codex/agents/*.toml`（个人）或 `.codex/agents/*.toml`（项目），必填 `name` / `description` / `developer_instructions`，可选 `model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers`、`skills.config`；未声明的设置（sandbox_mode、mcp_servers、skills.config 等）从父会话继承（[官方文档](https://developers.openai.com/codex/subagents)）。
- 内置 agent：`default`（通用）、`worker`（执行导向）、`explorer`（read-only 探索）（[官方文档](https://developers.openai.com/codex/subagents)）。
- 全局配置 `[agents]`：`enabled`、`max_concurrent_threads_per_session`（并发上限，默认由 Codex 定，旧别名 `max_threads`）、`default_subagent_model`、`default_subagent_reasoning_effort`、`interrupt_message`（[官方文档](https://developers.openai.com/codex/subagents)）。
- **沙箱策略由父继承**（subagents inherit your current sandbox policy），可对单个 agent 覆盖（如强制 read-only）；permission 由用户在 spawn 前选定（[官方文档](https://developers.openai.com/codex/subagents)）。
- 结果回传协议：subagent 通过 `spawn_agent` / `followup_task` 工具与父通信（子进程收到 NEW_TASK 载荷），followup_task 允许父对已 spawn 的 subagent 继续下发指令（[openai/codex#36586](https://github.com/openai/codex/issues/36586)；[cc-switch#5792](https://github.com/farion1231/cc-switch/issues/5792)）。
- 成本警告：每个 subagent 独立消耗模型与工具调用，比单 agent 贵（[官方文档](https://developers.openai.com/codex/subagents)）。

### 3.3 worktree 与嵌套

- **原生 git worktree 隔离在桌面 App**（ChatGPT 桌面版 Codex）：任务可跑在独立 worktree 上（detached HEAD、`$CODEX_HOME/worktrees`、Handoff 在本地/工作树间搬运任务、最多保留 15 个、`.worktreeinclude` 把被 gitignore 的配置文件带入 worktree）（[官方文档 Codex app worktrees](https://developers.openai.com/codex/app/worktrees)）。
- **CLI 无原生 worktree 隔离**：Codex subagent spawn 不暴露 `isolation=worktree` / `workdir` 能力（[GSD#3365](https://github.com/gsd-build/get-shit-done/issues/3365)），第三方编排需要自己准备 worktree 再以 `codex exec` 并行进程跑（[Polywave](https://github.com/blackwell-systems/polywave-codex)；[Firecrawl 多 agent 编排](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration)）。
- 嵌套：官方文档未提供嵌套 spawn；subagent 是 leaf，父用 `followup_task` 继续推进。

### 3.4 来源

- 官方：Subagents（https://developers.openai.com/codex/subagents）、App worktrees（https://developers.openai.com/codex/app/worktrees）
- 多 agent 协议实证：[openai/codex#36586](https://github.com/openai/codex/issues/36586)、[cc-switch#5792](https://github.com/farion1231/cc-switch/issues/5792)
- CLI 无原生 worktree 的第三方证据：[GSD#3365](https://github.com/gsd-build/get-shit-done/issues/3365)

## 四、Aider：无 subagent 的对照样本

### 4.1 定位

- Aider **没有 subagent/Task 概念**：单一交互式 agent 循环，一次处理一条消息，顺序执行（[官方 Chat modes](https://aider.chat/docs/usage/modes.html)）。它的差异化能力是 **git-first**（每次编辑自动提交、可回滚）与**模型无关**（任意 LLM provider），定位与 Claude Code 的「subagent runtime + 策略化委派」相反（[developersdigest 对比](https://www.developersdigest.tech/blog/aider-vs-claude-code-2026-update)）。
- 无原生 subagent 支持的最直接证据：GitHub issue「Build on Architect Mode with an /agent Command」（[Aider-AI/aider#3634](https://github.com/Aider-AI/aider/issues/3634)）仍停留在 feature request——社区想要的「自定义多步 agent 流程」并未进入产品。

### 4.2 上下文与双模型流水线

- 上下文不隔离：整个对话在同一个上下文里，靠 repo map（ctags/树状摘要）压缩仓库信息，用户用 `/add`、`/read` 手动控制上下文内容（[Skywork 对比](https://skywork.ai/skypage/en/claude-cli-subagent-guide/2044677663296782336)；[aider.chat](https://aider.chat/docs/usage/modes.html)）。
- **architect mode** 是它最接近「多 agent」的形态：一条请求发给两个模型——architect（主模型）先给出解决方案，editor 模型再把它翻译成具体的 SEARCH/REPLACE 文件编辑；这是**两个顺序的 LLM 请求**，不是并行 subagent（[aider.chat modes](https://aider.chat/docs/usage/modes.html)；[DeployHQ 指南](https://www.deployhq.com/guides/aider)）。
- 模式切换：`code` / `ask`（只讨论不改）/ `architect` / `help`，可用 `/ask`、`/code` 单条消息临时切换（[aider.chat](https://aider.chat/docs/usage/modes.html)）。
- 工具集无裁剪概念：模型通过 edit 格式直接改文件，无「子 agent 工具集」一说。

### 4.3 并行与安全

- 无内建并行：并行 = 用户开多个终端/实例，或外部编排器（如 loki-mode 等第三方框架在 Aider 上明确降级为串行、无 Task tool 可用，[loki-mode skills/providers.md](https://github.com/asklokesh/loki-mode/blob/main/skills/providers.md)）。
- 安全机制是 git：每次变更自动 commit，出问题回滚，而非 deny-first 权限分层（[arXiv 2604.14228 对 Aider 的定位](https://arxiv.org/html/2604.14228v1)）。

### 4.4 来源

- 官方：Chat modes / Architect mode（https://aider.chat/docs/usage/modes.html、https://aider.chat/docs/usage/architect.html）、Options（https://aider.chat/docs/config/options.html）
- 无 subagent 的证据：[Aider-AI/aider#3634](https://github.com/Aider-AI/aider/issues/3634)、[loki-mode](https://github.com/asklokesh/loki-mode/blob/main/skills/providers.md)

## 五、OpenHands（前 OpenDevin）：事件流 + 委派

### 5.1 事件流架构

- 所有 agent-环境交互是**不可变、类型安全的 typed event**，构成 append-only 日志：`ActionEvent`（agent 的工具调用）与 `ObservationEvent`（执行结果）分别映射到 LLM 的 `tool_calls` / `tool` role；`AgentErrorEvent` 让模型可见可恢复；同 `llm_response_id` 的多个 ActionEvent 合并为并行 function calling（[官方 Events 文档](https://docs.openhands.dev/sdk/arch/events)）。
- 执行隔离：每个任务会话在 **Docker 容器 sandbox**（Decker sandbox）里跑，事件流里的 action 通过容器内 REST API 执行（[OpenHands ICLR 2025 论文](https://proceedings.iclr.cc/paper_files/paper/2025/file/a4b6ad6b48850c0c331d1259fc66a69c-Paper-Conference.pdf)；[arXiv:2407.16741](https://arxiv.org/abs/2407.16741)）。

### 5.2 委派机制

- V0（论文版）：委派是一种特殊 action `AgentDelegateAction`——通用 CodeActAgent 把不擅长的子任务（如网页浏览）委派给专门 agent（BrowsingAgent），被委派 agent 有自己的上下文与循环（[ICLR 2025 论文 §2.4](https://proceedings.iclr.cc/paper_files/paper/2025/file/a4b6ad6b48850c0c331d1259fc66a69c-Paper-Conference.pdf)）。
- SDK 新版：**DelegateTool / TaskToolSet** 提供 spawn→delegate 两段式：`spawn` 先按 id 列表初始化 subagent（如 `["lodging","activities"]`），`delegate` 再按 id→任务字典派活；**所有 subagent 用线程并行执行、阻塞到全部完成、返回单个合并 observation**（错误按 subagent 逐个上报）（[官方 Agent Delegation 指南](https://docs.openhands.dev/sdk/guides/agent-delegation)）。
- subagent 属性：继承父的 LLM 配置、**与主 agent 同一 workspace**、**各自独立对话上下文**（[Agent Delegation 指南](https://docs.openhands.dev/sdk/guides/agent-delegation)）。
- 并发上限：可继承 DelegateTool 覆写 `max_children`（如最多 3 个）（[Agent Delegation 指南](https://docs.openhands.dev/sdk/guides/agent-delegation)）。

### 5.3 文件式 agent 定义

- 与 Claude Code 高度同构：`.agents/agents/*.md`（项目）/ `~/.agents/agents/*.md`（个人）的 Markdown + YAML frontmatter（`name`、`description`（可带 `<example>` 触发示例）、`tools`、`model`（默认 `inherit`）、`skills`、`max_iteration_per_run`、`mcp_servers`、`hooks`、`permission_mode`），正文是 system prompt（[官方 File-Based Agents 文档](https://docs.openhands.dev/sdk/guides/agent-file-based)）。
- 内置 subagent：`general-purpose`（terminal+file_editor+task_tracker）、`code-explorer`（read-only）、`bash-runner`、`web-researcher`；`explore`/`bash`/`default` 为已废弃旧名（[File-Based Agents](https://docs.openhands.dev/sdk/guides/agent-file-based)）。
- 权限：`permission_mode`（`always_confirm` / `never_confirm` / `confirm_risky`，后者的风险判定需要 security analyzer）；省略则**继承父会话的确认策略**（[File-Based Agents](https://docs.openhands.dev/sdk/guides/agent-file-based)）。
- 委派是**单层**的：subagent 工具集由定义决定，不自动包含委派工具（对比：Hermes Agent 把嵌套委派做成显式 opt-in，仅 orchestrator 角色可再委派——那是另一产品，但说明了「嵌套需显式设计」这一业界共识，[Hermes Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)）。

### 5.4 来源

- 官方：Events（https://docs.openhands.dev/sdk/arch/events）、Agent Delegation（https://docs.openhands.dev/sdk/guides/agent-delegation）、File-Based Agents（https://docs.openhands.dev/sdk/guides/agent-file-based）
- 论文：[OpenHands: An Open Platform for AI Software Developers as Generalist Agents（arXiv:2407.16741，ICLR 2025）](https://arxiv.org/abs/2407.16741)、[The OpenHands Software Agent SDK（arXiv:2511.03690）](https://arxiv.org/abs/2511.03690)

## 六、横向对比

| 维度 | Claude Code | Codex CLI | Aider | OpenHands |
| --- | --- | --- | --- | --- |
| 委派机制 | Agent tool（Task 旧名），同进程子会话 | subagent workflow，宿主编排 | 无 subagent；双模型流水线（architect/editor） | AgentDelegateAction / spawn-delegate 工具 |
| 上下文隔离 | 独立窗口，仅摘要回传；sidechain 单独存盘 | 独立 agent thread，summary 回传 | 不隔离（单上下文 + repo map） | 独立对话上下文，合并结果回传 |
| 工具集裁剪 | `tools` allowlist + `disallowedTools` | agent TOML 声明；沙箱模式覆盖 | 无 | `tools` allowlist（文件式定义） |
| 自定义定义 | `.claude/agents/*.md` frontmatter | `.codex/agents/*.toml` | 无 | `.agents/agents/*.md` frontmatter |
| 权限 | `permissionMode`，父更宽者优先；bubble 冒泡 | 继承父 sandbox policy，可覆盖 | git 提交即安全网 | `permission_mode` 或继承父 |
| 嵌套 | 不支持 | 未提供（leaf + followup_task） | N/A | 单层（subagent 无委派工具） |
| 并行 | 一条消息多个 Agent 调用并发 | 并行 spawn，等待全部后合并；有并发上限 | 无内建，多实例手动并行 | 线程并行，阻塞合并，max_children 上限 |
| 执行隔离 | 进程内（无隔离）；可选 git worktree | OS 沙箱；worktree 仅桌面 App | 直接改文件 + git 回滚 | Docker 容器沙箱 |
| 结果回传 | 子会话总结文本 | 子 agent 响应合并；followup_task 续问 | N/A（同一对话） | 合并 observation，逐 subagent 报错 |

## 七、对本项目的设计启示

（面向 `src/engine/` 现有审批/工具系统，以及后续的 goal + subagent 能力与「git worktree 隔离 + 区内放行/出区必批」自进化笼子）

1. **subagent 的第一原则是上下文隔离 + 摘要回传**。Claude Code 与 Codex 都把「中间输出不进入父上下文」作为核心卖点。本项目应让 subagent 用独立的消息数组跑同一引擎 loop，结束后只把最终结果（结构化摘要）作为一条 tool 结果并入父上下文；子会话全文单独落盘（对应 sidechain transcript），便于审计与恢复。
2. **Agent tool 应是普通工具之一**。Claude Code 的 Agent tool 与普通工具走同一个 `buildTool()` 工厂、复用同一 `queryLoop()`——它只是「带独立上下文的工具」。这正好契合本项目「引擎零 TUI 依赖、工具系统已有注册表」的现状：新增 `spawn_subagent` 工具，内部新建一个 `TurnManager`/loop 实例跑子任务，收益是权限、hook、工具护栏全部天然复用。
3. **文件式 agent 定义 + description 即路由**。抄 Claude Code / OpenHands 的 `*.md` + YAML frontmatter：`name`、`description`（含触发时机）、`tools`（allowlist）、`model`。父 agent 根据 description 自动选型，人工可点名强制。先内置两个 read-only 角色（explore / plan）加一个 general-purpose，正好复用现有 Explore/Plan 思路（项目已有 `subagent_type=explore/plan` 的语境）。
4. **工具裁剪用 allowlist + 黑名单双机制**，且 Explore/Plan 默认只读。参照 Claude Code：read-only 角色直接禁 Write/Edit；后台/并行角色可给更小工具集。与现有审批系统对接：subagent 的工具体验到父级的审批链，但**父级更宽的模式优先**、subagent 只能声明更严的策略——这与「区内放行/出区必批」的笼子语义一致：子 agent 的活动半径由工具集 + 审批规则共同界定。
5. **并行 = 一条消息多个 spawn 调用并发 + 显式上限**。Claude Code 的做法（同一轮多个 Agent 调用并发执行、各自独立回传）实现成本最低。设 `maxConcurrent` 上限（对标 Codex 的 `max_concurrent_threads_per_session` 与 OpenHands 的 `max_children`），并约束 write-heavy 并行（业界普遍建议并行优先用于 read-heavy）。
6. **第一版不做嵌套**。业界主流均不支持或默认单层；subagent 间不通信，只与父通信。嵌套带来的编排复杂度可留到 agent teams / workflow 形态再评估。
7. **worktree 隔离的方案细节照抄成熟做法**，注意几个坑（均有官方/社区证据）：
   - 采用 detached HEAD 起步，避免「同一 branch 只能在一个 worktree 检出」的 git 限制（Codex App 的做法）；
   - `.gitignore` 的文件不随 worktree 走，需要 `.worktreeinclude` 类机制把 `.env`/`AGENTS.override.md` 等复制进去（Codex App）；
   - 完成后再 merge 回主工作树，且保留快照/恢复能力（Codex 在删除 worktree 前保存快照）；
   - Claude Code 的 `isolation: worktree` 是「默认 in-process、可选 worktree」，本项目可先做 in-process + 可选 worktree，把隔离做成可插拔档位。
   - 与本项目「区内放行/出区必批」笼子结合：worktree 是「区」的物理边界，审批规则是「区」的逻辑边界，两层叠加最接近 Claude Code（工作树隔离）+ OpenHands（容器）的纵深防御。
8. **Aider 的反面教训与正面启发**：无上下文隔离在长任务上必然退化（context rot），不推荐抄；但其「git 即安全网、每步可回滚」与自进化笼子（agent 改自己的代码库）天然契合——subagent 每次改动自动 commit，出区操作被审批卡住时可直接回滚，比纯权限拦截更可逆。
9. **统一结果契约**：subagent 的返回应该是可被父 agent 消费的结构化摘要（要点 + 文件路径 + 失败原因），而不是原始工具输出；OpenHands 的「合并 observation + 逐 subagent 报错」与 Codex 的「等全部完成再合成」都值得对齐。

## 附：关键来源索引

- Claude Code：官方 sub-agents / agents / agent-teams 文档（code.claude.com）；[arXiv:2604.14228 架构剖析](https://arxiv.org/html/2604.14228v1)；[Shiplight 机制详解](https://www.shiplight.ai/blog/claude-code-subagents)
- Codex：官方 [subagents](https://developers.openai.com/codex/subagents) 与 [app/worktrees](https://developers.openai.com/codex/app/worktrees)；协议实证 [openai/codex#36586](https://github.com/openai/codex/issues/36586)
- Aider：官方 [modes](https://aider.chat/docs/usage/modes.html)；无 subagent 证据 [aider#3634](https://github.com/Aider-AI/aider/issues/3634)
- OpenHands：官方 [Events](https://docs.openhands.dev/sdk/arch/events) / [Agent Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation) / [File-Based Agents](https://docs.openhands.dev/sdk/guides/agent-file-based)；[arXiv:2407.16741](https://arxiv.org/abs/2407.16741)、[arXiv:2511.03690](https://arxiv.org/abs/2511.03690)
