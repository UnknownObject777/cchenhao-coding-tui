# 主机 CLI（kimi-code）的 goal / subagent 语义清单

> 研究 ticket：#65（wayfinder:research），父 issue #64（spec-v3：goal + subagent 能力与自进化笼子）。
> 结论可作为 `docs/spec-v3` 的语义蓝本：本项目（cchenhao-coding-tui）的 goal/subagent 能力「照搬主机 CLI 语义」。

## 结论先行（TL;DR）

**Goal mode**：一个持久目标 + 每 turn 末的四态检查（`active / complete / paused / blocked`）。命令面为 `/goal [status|pause|resume|cancel|replace|next]`；**停止条件写进目标文本**，没有独立的 stop-limit 语法。三种停止方式：`complete`（清除目标 + 总结）、`paused`（用户暂停 / 中断 turn / 恢复带活跃目标的会话 / 模型或运行时错误）、`blocked`（需要输入 / 无法按现状完成 / **达到预算上限**），blocked 时 agent 必须写一条原因消息。token 预算存在（web UI 显示进度条、耗尽触发 blocked），但**官方文档未给出配置入口**（见「文档缺口」）。自动续跑 = 每 turn 后检查并自动继续，加上 `/goal next` 队列（当前目标完成后自动补位）与 print 模式的 `steer` 回环。冷重建 = 会话目录下 append-only 的 `wire.jsonl` 事件流 + `state.json`，按需回放恢复上下文与子代理状态。

**Subagent**：每会话一个 main Agent，按需派发 sub-agent 处理聚焦子任务。sub-agent 拿到的是**显式传入的任务描述**，拥有**完全独立的上下文窗口**，中间推理与工具调用不回传，只有最终结果进入主上下文（三条内置：`coder` / `explore` / `plan`）。`Agent` 工具（`prompt` + `description` 必填；`subagent_type` 默认 `coder`；`resume` 续跑已有实例且与 `subagent_type` 互斥；`run_in_background` 默认 false；`model` primary/secondary）与 `AgentSwarm`（`prompt_template` + `items`，或 `resume_agent_ids`；≥2 项 / ≤128 个；聚合报告；并发爬坡 5 起 + 每 700ms 加 1）。权限从主 agent **继承**（allow 规则自动传播，`Agent` 工具默认 auto-allow，`AgentSwarm` 需审批除非 swarm mode）。默认超时 2 小时（`[subagent] timeout_ms`）。子代理状态同样落盘到 `agents/<subagentId>/wire.jsonl`，支持续跑与恢复。

**与本项目的关系**：本仓库 `lessons/0008` 的 wire 持久化 / 冷重建已实现主机的核心模式（append-only 事件日志、双通道重建），缺的是 goal / subagent 这两类新的事件与状态；审批系统（`test/approval-rules.test.ts`）可按主机的「权限规则继承 + `ToolName(arg-pattern)` 路径匹配」扩展成自进化笼子的「区内放行 / 出区必批」门。

---

## 来源与时效

- 一手来源（官方文档，2026-08-10 抓取，`/docs/en/`）：
  - [Goals](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/goals.html)
  - [Agents & Sub-Agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)
  - [Built-in Tools](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html)
  - [Sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
  - [Slash Commands](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html)
  - [Configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html)
  - [Environment variables](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)
  - 中文版 Goals 页（`/docs/` 无 locale 前缀，内容与英文一致）已交叉核对：[Goals（中）](https://www.kimi.com/code/docs/kimi-code-cli/guides/goals.html)
- 二手来源：Kimi Code 0.24.2 发行说明镜像（print 模式 goal 存活语义）——[NewReleases.io](https://newreleases.io/project/github/MoonshotAI/kimi-code/release/@moonshot-ai%2Fkimi-code@0.24.2)
- 本地来源：`lessons/0008-wire持久化与冷重建.md`（本项目 wire/冷重建既有语义）、`docs/spec-v2.md`、issue #64（父 ticket）。

> 时效注意：goal mode 是较新功能（发行说明与文档最近仍在补细节，例如 `kimi -p "/goal ..."` 存活语义是 0.24.2 才对齐）；文档个别处与发行说明存在细微出入时，以文档页为准、差异单列。

---

## 一、Goal mode 语义清单

### 1.1 进入方式与基本模型

- 入口：TUI 中 `/goal <objective>`；`kimi -p "/goal ..."`（非交互 prompt 模式**只支持创建**，其余管理命令是 TUI 控制，`/goal next` 等不处理）。
- 语义：目标被保存 → **作为下一条用户消息发送** → 进入 goal mode。目标说的是「最终要达成什么状态」，不是「下一步做什么」。
- 好目标 = 写清楚完成条件 + 可验证证据（文件 / 测试 / 命令输出 / 产物 / 明确报告）。宽泛方向（"找出所有 bug"）会导致立即 blocked 或超长运行。
- 非目标（如 "你好！"）会被立即标记 complete；不可能的任务（"证明 1+1=3"）会被标记 blocked。

### 1.2 生命周期与命令面

| 命令 | 行为 | 可用时机 |
| --- | --- | --- |
| `/goal` 或 `/goal status` | 显示当前目标 + 状态 / 耗时 / turn 数 / token 数 | 始终 |
| `/goal pause` | 暂停活跃目标但不删除 | 始终 |
| `/goal resume` | 恢复 paused 或 blocked 的目标 | 仅 idle |
| `/goal cancel` | 移除当前目标（**需确认，取消后不可恢复**） | 始终 |
| `/goal replace <objective>` | 用新目标替换当前目标 | 仅 idle |
| `/goal next <objective>` | 排队后续目标；无活跃目标时立即开始 | 始终 |
| `/goal next manage` | 交互式管理排队目标（浏览/排序/编辑/删除） | 始终 |

- **每轮 turn 结束后检查四态**：`complete` / `blocked` / `paused` / `active`（active 则自动继续下一 turn——这是「自动续跑」的机制内核，见 1.5）。
- 子命令词（status/pause/resume/cancel/replace/next）仅当是 `/goal` 后第一个词时生效；目标本身以这些词开头需用 `--`（如 `/goal -- cancel the old rollout note ...`）。
- 停止条件**写进目标文本**：`/goal` 没有单独的 stop-limit 语法（没有 stop-turn 参数之类）。

### 1.3 三种停止方式（终态 / 暂停）

| 状态 | 触发条件 | 系统行为 |
| --- | --- | --- |
| `complete` | 目标完成 | 清除目标；agent 总结如何完成 |
| `paused` | 用户暂停；中断 turn；**恢复一个带有活跃目标的会话**；模型 / 供应商 / 运行时错误 | 目标保留，可 resume |
| `blocked` | 需要用户输入；无法按当前表述完成；**达到预算上限** | agent **写一条简短消息说明原因**；可 resume |

- 注意 paused 的一个来源：**resume 会话时若该会话有活跃目标，目标会先变 paused**——恢复会话 ≠ 自动继续目标（web UI 需手动点 Resume）。
- blocked 与 paused 都会保留目标（可 `/goal resume` 恢复）；cancel 才移除且不可恢复。

### 1.4 预算（token budget）

- 文档事实：web UI 目标条在**配置了 token 预算**时显示预算进度条；未配置则不显示进度条。**达到预算上限是 blocked 的触发条件之一**（不是杀掉进程，是进入可审计、可 resume 的 blocked 态）。
- **配置位置：官方文档未给出**（config-files 无 `[goal]` 段；env-vars 无 goal 预算变量；goals 页只说 "when a token budget is configured"）。见「文档缺口」。
- 主机上可用的间接边界（`config.toml`）：`[loop_control] max_steps_per_turn`（默认无上限；`KIMI_LOOP_MAX_STEPS_PER_TURN`）、`max_attempts_per_step`（默认 10，含首次）、`reserved_context_size`（压缩触发阈值）。`/goal status` 的耗时 / turn 数 / token 数是审计刻度的事实来源。
- 对本项目 #64「放养默认值（turns/tokens/时间刻度）」的含义：主机只定义了「预算耗尽 → blocked」这一语义事实，具体刻度（多少 turn / 多少 token）仍由各目标自行约定——spec 需要自己定刻度。

### 1.5 自动续跑

- **机制内核**：goal mode = 「持久目标 + 自动延续的 turns」。每 turn 结束后系统检查四态；非终态则继续下一 turn。不是常驻循环，是 **turn 级自动延续**。
- **队列补位**：`/goal next` 排队的后续目标对运行中的 agent **不可见**；当前目标 complete 后，系统以与 `/goal <objective>` 相同的方式自动启动第一个排队目标。当前目标 paused / canceled / blocked 时**不会**自动启动下一个；blocked 且存在排队目标时 TUI 会提醒。
- **Web UI**：目标条上的 Resume 会「启动下一轮目标工作」。
- **print 模式**（`kimi -p`）：目标完成 / 阻塞 / 暂停时分别以退出码 `0` / `3` / `6` 退出；0.24.2 起 `kimi -p "/goal ..."` **存活到目标到达终态**而不是跑完第一个 turn 就退出（发行说明镜像）。print 模式下后台任务完成以 synthetic user message 注入并驱动新 turn（`print_background_mode = "steer"` 默认，`print_max_turns` 默认 100000、`print_wait_ceiling_s` 兜底）。
- 权限提醒：`manual` 权限模式下 goal 工作可能停下等工具审批——无人值守需用匹配风险的权限模式（auto / yolo）。

### 1.6 冷重建（会话恢复 / 回放）

- 存储布局（sessions 页）：`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/`：
  - `state.json`：会话元数据（标题、创建时间）。
  - `agents/main/wire.jsonl`：主 agent 事件流，**用于会话恢复与回放**；同时带 request trace（发给模型的 tool schemas / 请求参数 / MCP 工具清单，调试用）。
  - `agents/<subagentId>/wire.jsonl`：子代理事件流（见 2.6）。
- 恢复命令：`kimi --continue`（当前目录最近会话）、`kimi --session <id>`、`kimi --session`（交互浏览）；`--continue` 与 `--session` 互斥。
- **agent 绑定随会话持久化**：`--agent` 在会话创建时绑定，resume 自动恢复绑定 agent（resume 时不能也不需要再传 flag）；会话内 `/new` 新建的会话用默认 agent。
- 警告：不要手动编辑 `sessions/` 目录，否则会话可能无法恢复。
- 与本项目的对应：`lessons/0008` 已实现同构模式——`src/engine/wire.ts` 的 append-only JSONL（坏行跳过）、双通道 rebuild（`rebuild()` → UI 消息列表；`rebuildForContext()` → LLM `Message[]` 并恢复 toolCall 配对；中断会话的 tool.call 合成占位回复）、`rebuildTodos()` 还原 todo 快照、压缩事件作为上下文复位点。主机在这些之上多了：goal 状态、subagent 实例（`agents/<id>/`）、`state.json` 元数据。

### 1.7 与审批 / 权限系统的交互

- 只读工具（`Read`/`Grep`/`Glob`/`ReadMediaFile` 等）默认 auto-allow；写与执行工具（`Write`/`Edit`/`Bash`）默认需审批；YOLO 跳过常规审批（Plan mode 退出审批不受影响）。
- 权限规则（`[[permission.rules]]`）：`decision` = allow / deny / ask；`scope` = turn-override / session-runtime / project / user（默认 user）；`pattern` = `ToolName` 或 `ToolName(arg-pattern)`（如 `Bash(rm -rf*)`）；**首个匹配生效**。
- goal 场景：manual 模式下无人值守目标会卡在审批上；`ask`/`deny` 规则对 goal 的自动续跑是直接约束面。

---

## 二、Subagent 机制语义清单

### 2.1 架构：main Agent + sub-agents

- 每会话一个 **main Agent**（理解意图、规划、调工具），按需派发 **sub-agent** 处理聚焦子任务（探索陌生代码库、并行评审多个实现、规划大重构而不污染主上下文）。
- sub-agent 收到的是 main Agent **显式传入的任务描述**；在**自己完全独立的上下文窗口**里工作；**不直接与用户通信**；中间推理与工具调用记录**不混入 main Agent 历史**；只有最终结果出现在主上下文。
- 三个内置 sub-agent：`coder`（默认；通用软件工程：读写文件、跑命令、搜代码、落变更）、`explore`（只读探索，不改文件）、`plan`（纯规划，连 shell 都没有）。`coder` 共享主 agent 大部分工具：后台 shell、todo 列表、Plan mode、Agent Skills、嵌套派发自己的 sub-agent。
- `coder` 的后台任务语义：若其 turn 结束时仍有后台任务在跑，**run 只在那些任务 settle 后才报告完成**——父 agent 拿到结果时底层工作已真正结束。

### 2.2 `Agent` 工具（派发）

- 必填：`prompt`（完整任务描述）、`description`（3–5 词摘要）。
- 可选：`subagent_type`（默认 `coder`）；`resume`（已存在 sub-agent 的 ID；**与 `subagent_type` 互斥**）；`run_in_background`（默认 false）；`model`（`"secondary"` / `"primary"`，见 2.7）。
- **前台**：父 agent 阻塞等待 sub-agent 完成再继续；同一步多个前台 `Agent` 调用时 TUI 分组显示各 subagent 的 running / waiting / completed / failed + 耗时。
- **后台**：立即返回 task ID；完成时结果以 **synthetic user message** 自动回传给主 agent，无需轮询。
- **超时**：默认 2 小时（`[subagent] timeout_ms`，`KIMI_SUBAGENT_TIMEOUT_MS`；print 模式默认 `0` = 无超时）；`0` = 无超时；值 > 2147483647ms 被 clamp 到约 24.8 天；对前台与后台同样适用。
- **默认审批：`Agent` 工具 auto-allow**——主 agent 可多次委派而不打断用户。权限规则只按工具名匹配（`Agent` 无参数 pattern）。
- 超时后**续跑同一 agent**（`resume`）是官方推荐做法，而不是从头派发（agents 页 "call back an existing sub-agent instance to continue the same task"）。

### 2.3 `AgentSwarm` 工具（批量）

- 输入：`prompt_template`（必须含 `{{item}}` 占位符）+ `items` 数组（每项启动一个新 subagent）；或 `resume_agent_ids`（续跑已存在 subagent）；或两者结合。`subagent_type` 统一选择所有 spawn 的 profile（默认 `coder`）；`model` 统一（secondary / primary）。
- 约束：无 resume 时 **≥ 2 个 items**；总计 **≤ 128**；等全部完成返回**聚合报告**；**该调用必须是响应中唯一的工具调用**（要跑多个 swarm 需串行）。
- 并发爬坡：默认 5 个立即启动，然后每 700ms 加 1 个；`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`（正整数）封顶，非法值 fail fast。
- 审批：**swarm mode 激活时 `AgentSwarm` 自身 auto-approve**；manual 模式下非 swarm mode 调用需审批（权限规则仅按工具名 `AgentSwarm` 匹配，不支持 `AgentSwarm(swarm)` 参数 pattern）。
- TUI：前台 swarm 显示实时 `Agent swarm` 进度面板。

### 2.4 上下文隔离与资源成本

- **完全独立的上下文窗口**；只能看到显式传入的任务描述，看不到主会话历史。
- 中间过程不回传：sub-agent 的推理与工具调用记录不进主上下文，只有最终结果。
- 两个收益（官方明示）：主上下文保持精简；多个 sub-agent 可并行互不干扰。
- 成本：每个 sub-agent 独立消耗模型 token；简单任务不派发更经济。

### 2.5 resume（续跑）语义

- `resume: <agent_id>` 回调已有 sub-agent 实例继续同一任务；与 `subagent_type` 互斥；resume 时 `model` 参数被忽略（**resumed subagents 保留自己的模型**）。
- resume **豁免** `subagents` 允许列表复查（profile 的 `subagents` 字段控制可派发类型，但续跑不受限）。
- 子代理状态持久化（sessions 布局）：`agents/<subagentId>/wire.jsonl` 记录 prompts / message history / final state；后台 sub-agent 通过 `tasks/` 子目录暴露生命周期状态——这些正是 resume / 冷恢复的载体。

### 2.6 前后台统一（与 Bash 后台任务同构）

- 后台任务工具：`TaskList`（`active_only` 默认 true、`limit` 默认 20）、`TaskOutput`（非阻塞快照；返回 `output_path` 供 Read 分页；完成经自动通知）、`TaskStop`（需审批；可选 `reason`）。
- `Bash`：`run_in_background=true` 立即返回 task ID、完成自动通知；前台超时默认**转后台**（`bash_auto_background_on_timeout` 默认 true）；`[background] max_running_tasks` 并发上限、`keep_alive_on_exit`（默认 false：进程退出前请求所有后台任务停止）、`kill_grace_period_ms`（默认 5000；SIGTERM → 5s 宽限 → SIGKILL 两阶段终止）。
- print 模式（`print_background_mode`）：`exit`（turn 结束即退出）/ `drain`（等所有后台任务到终态再退出，不回传结果）/ `steer`（默认；后台完成注入 synthetic user message 驱动新 turn，直到无 pending 或 `print_max_turns` / `print_wait_ceiling_s` 上限）。

### 2.7 模型绑定（primary / secondary）

- 默认：新 spawn 的 sub-agent 绑定 `[secondary_model] model`（实验特性，需 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`）；未配置则继承主 agent 模型。
- 解析顺序：显式 tool-call `model` → profile 的 `model_preference` → 配置的 secondary model →（无 secondary 时）继承 caller 模型。`"primary"` = 主 agent **当前正在运行**的模型（可能被 `/model` 切过，不是 `default_model`）。
- profile 文件字段（frontmatter）：`name` / `description`（必填）/ `whenToUse` / `override` / `model_preference` / `tools`（允许列表）/ `disallowedTools`（拒绝列表，后应用）/ `subagents`（可派发类型允许列表）。`tools` / `subagents` 在 prompt 塑造层面 + 执行前双重强制；resume 豁免。
- 发现优先级：**Explicit（`--agent-file`）> Project > Extra > User > Plugin > Built-in**；同名高优先级胜。`--agent-file` 每次启动只接受一个文件、与 `--session`/`--continue` 互斥（agent 在会话创建时绑定）。
- **信任模型**：项目级 agent 文件来自仓库本身（包括刚 clone 的、未信任的仓库）；`override: true` 的 `agent.md` 可整体替换默认主 agent 系统提示、`coder.md` 可替换默认子代理类型——与 `AGENTS.md` 不同（后者只是注入参考数据，override 文件**就是系统提示**）。文档明确要求进入陌生仓库前先审查 `.kimi-code/agents/` 与 `.agents/agents/`。
- 系统提示模板变量：`${base_prompt}`、`${agents_md}`、`${cwd}`、`${os}`、`${shell}`、`${now}`、`${skills}`、`${plugin_sections}` 等，用于包装默认提示而非替换。

### 2.8 权限继承

- **sub-agent 的权限规则从主 agent 继承**：主 agent 通过 `/permission` 或审批对话框接受的 "always allow" 规则**自动传播**给其派发的所有 sub-agent，无需重复审批。
- 想让某类工具在 sub-agent 内永久不可用 → 收紧主 agent 上的对应权限规则。
- 与「自进化笼子」的直接相关性见「设计启示」6。

---

## 三、文档缺口与存疑（务必读）

1. **`CreateGoal` / `UpdateGoal` / `GetGoal` / `SetGoalBudget` 这四个工具名不在官方 tools 参考页**。公开文档把 goal 生命周期暴露为 `/goal` 命令 + web UI 目标条；v2 引擎（agent-core-v2）的 agent 工具面里存在这组 goal 工具（本清单作者运行环境即 kimi-code，工具面含 CreateGoal / GetGoal / UpdateGoal / SetGoalBudget），对应关系按名字推断：`CreateGoal` ≈ `/goal <objective>`、`GetGoal` ≈ `/goal status`、`UpdateGoal` ≈ `/goal replace`、`SetGoalBudget` ≈ 设 token 预算。**推断成分，spec 蓝本以文档的 `/goal` 语义为准**。
2. **token 预算的配置位置未文档化**：goals 页只说「配置了 token budget 时显示进度条」「达到预算上限 → blocked」，config-files / env-vars 均无对应字段。spec 若要「预算」能力，得自己定义配置面（或先只做 turn 数预算）。
3. **「subagent 是同进程实例」**：官方文档的佐证是子代理与主会话同目录持久化、由同一运行时管理（hooks、任务管理器共享）；「同进程」字面表述来自本 ticket 的既定认知与本工具面的实现事实，文档未逐字说明。
4. **发行说明 vs 文档的时序差异**：print 模式 goal 存活 / 子代理超时对齐是 0.24.2（二手镜像）记录的行为；文档 goals 页的退出码语义（0/3/6）与之一致。以文档页为准。
5. `AGENTS.md` 中 `lessons/` 与 `docs/` 未提及 goal/subagent 既有描述（spec-v2 明确把 subagent 列为 Out of scope）——本清单是仓库内关于主机语义的**第一份**整理。

---

## 四、对本项目的设计启示

以下每条都以「主机事实 → 本项目映射」给出，供 `docs/spec-v3` 直接引用。

1. **Goal 状态机照搬四态**：`active / complete / paused / blocked` + 每 turn 末检查。本项目 Loop（`src/engine/loop.ts`）的 turn 收尾点天然是挂检查的位置（lesson 0004 的 loop 状态机 + `publish()` 双发）。blocked 的三类触发（需输入 / 无法完成 / 预算上限）与 paused 的「resume 带活跃目标的会话 → 先 paused」这条细节都要保留——它决定了「冷恢复后目标默认不自动续跑」的安全默认。

2. **预算先做 turn 数，token 预算留接口**：主机只承诺「预算耗尽 → blocked（附原因）」，配置位置未定。项目最小可行：`max_turns_per_goal`（写进 goal 对象）→ 超限进 blocked；token 预算作为 goal 对象的可选字段预留，spec 不承诺配置面。

3. **blocked 审计 = 一条结构化原因消息**：主机要求 blocked 时 agent 写原因。本项目可把「goal 状态变化」作为事件进 wire（`goal.updated`），blocked 事件必带 `reason` + `suggestedNext`；`/goal status` 式的审计面（状态 / 耗时 / turn 数 / token 数）由 wire 重放派生，不额外存储。

4. **自动续跑是 turn 级机制，不是常驻循环**：goal mode = 「每 turn 后检查 + 自动继续」+ 队列补位。本项目在 loop 外再加一层「goal 驱动器」即可，不必改 loop 内核；`/goal next` 队列语义（运行中对 agent 不可见、complete 后自动补位、paused/canceled/blocked 时不补位）值得完整照搬，是「放养式自进化」的关键 UX。print 模式 `steer` 回环（后台完成 → synthetic user message → 新 turn）可借用为无头放养模式。

5. **冷重建扩展而非重写**：`lessons/0008` 已覆盖 wire 事件流 + 双通道 rebuild + 坏行跳过。增量是：① goal 状态事件（`goal.created/updated/blocked`）进 wire，冷重建还原 goal 对象——与 `todo.updated` 快照还原同一模式；② subagent 实例落盘到 `agents/<subagentId>/wire.jsonl`（与主 wire 同构，可用同一 WireService，按 agent id 分文件）；③ resume 依赖「子代理最终消息 + 独立上下文折叠」，这要求 subagent 的上下文重建是纯函数（同 lesson 0008 的「压缩也是事实」原则）。

6. **自进化笼子的权限建模直接用主机语义**：笼子 = worktree 隔离 + 审批门。主机已给出建模工具：权限规则 `ToolName(arg-pattern)` + 首个匹配生效 + scope（project/user）+ **sub-agent 自动继承主 agent 的 allow 规则**。映射：区内路径（worktree 根）配 `allow`，区外路径配 `ask`；`Agent` 工具本身 auto-allow（派发不打扰人），但子代理继承的权限视图与主 agent 一致——所以笼子的门只需定义在「主 agent 的权限视图」上，不必为 sub-agent 单独开洞。`override: true` 的 agent 文件 / 项目级 agent 文件是信任边界（文档明确警告），笼子设计应把「仓库内 agent 文件」当作不可信输入对待（如同主机的提示）。
7. **超时与并发参数直接抄**：subagent 2h 默认 / `0`=无超时 / print 模式默认无超时；swarm 并发爬坡（5 起 + 每 700ms 加 1）+ 上限；前台超时转后台（`bash_auto_background_on_timeout`）。这些是已经过验证的默认值，spec 无需重新发明。
8. **模型绑定接口预留**：`model: "secondary" | "primary"` + resume 保留原模型——本项目单模型玩具可先不实现，但 goal/subagent 的对象模型里预留 `model` 字段，避免日后结构改动。
9. **验收锚点**：主机语义的可测事实 = print 退出码（0 complete / 3 blocked / 6 paused）、四态转换表、budget 耗尽 → blocked、`/goal next` 补位规则、subagent 上下文隔离（主上下文只见最终结果）、resume 免复查且保留模型。这些可直接转成本项目验收测试（`test/` 现有 approval-rules / background-task / context 测试可复用模式）。
