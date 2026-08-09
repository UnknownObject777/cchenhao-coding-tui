# cchenhao-coding-tui · mini-coding-agent

> 一个跑在终端里的迷你 coding agent：**引擎全部自写**（loop / llmRequester / toolExecutor / wire），**TUI 分层对照 kimi-code 真实架构**。MVP 已完成，已进入每周真用 + spec-v3 自举验收阶段。

## 这是什么

用最小的代码，把两件事同时落到手：**一个 coding agent 是怎么跑起来的**（引擎），以及**真实产品的 TUI 是怎么组织的**（分层）。

- **引擎自写，没有黑盒**。turn 状态机（loop）、LLM 流接入、工具执行器、wire 事件日志——每一层都能直接读源码、动手改，是理解 agent 内部机制的第一块上手板。
- **TUI 分层照搬 kimi-code**。streaming-ui / 消息组件 / theme / coordinator 与真实仓库逐目录对应，可拿着 [kimi-code](https://github.com/MoonshotAI/kimi-code) 对照学习（见[架构对照表](#目录结构与-kimi-code-对照)）。
- **不是 demo，是真的在用**。标准工具链（文件读写/编辑、grep/glob、命令执行、web 搜索/抓取、todo 计划、skills 按需加载）全部落地，作者用它完成 ≥3 个真实小任务并通过验收（issue #50）——之后它也一直在负责仓库自身的开发。
- **安全默认值**。分级审批 + 危险命令/跨工作区写拒绝 + 会话「始终允许」记忆 + diff 预览与 git 感知，关键文件写操作强制确认。
- **5 秒开始演示**。`FAKE_LLM=1` 无需任何凭证即可跑完「写文件 → 读回 → 总结」的完整工具调用 turn。

## 快速开始

要求 Node ≥ 22.19（bin 依赖 Node 原生 TypeScript type-stripping）。

```bash
npm install
npm link                  # 全局可用：mini-agent

mini-agent                # 交互式 TUI（有历史会话先出选择器）
mini-agent --new          # 强制新会话
mini-agent -p "任务"       # print 模式（一次性，stdout 出结果）
mini-agent -p --yes "任务" # print 模式放行写/执行类工具调用
mini-agent -p "任务" --output-format stream-json  # 引擎事件逐行 JSON，可管道消费
```

无凭证演示：`FAKE_LLM=1 mini-agent`（预置脚本，无需 API key）。

## 特性一览

| 能力 | 说明 |
| --- | --- |
| 引擎 | 自写 turn 状态机：LLM 流 → 事件 → tool call 回灌 → finish，`maxRounds` 防死循环 |
| TUI | streaming delta 增量渲染、think 折叠、工具帧折叠/展开、暗/亮主题检测、slash 补全、会话选择器 |
| 工具链 | read_file / write_file / edit_file / run_command（同步 + 后台）/ list_files / grep / glob / web_search / web_fetch / todo |
| 审批 | 分级规则（allow / confirm / deny）+ 会话记忆 + diff 预览 + git 感知；危险 pattern 直接拒绝 |
| 会话 | wire append-only 事件日志，冷重建恢复上下文、审批记忆与 todo，跨进程重启可续 |
| 上下文 | 预算高水位（`context_budget` 可配置）触发真压缩：同模型一次摘要 + 保留最近尾部 |
| Skills | SKILL.md 按需加载：清单进 system prompt，`load_skill` / `/<name>` 取全文 |
| 配置 | env > 项目级 `.agent.json` > 用户级 `config.json` 三级优先级，订阅 OAuth 兜底 |
| Provider | kimi / OpenAI / 任意 OpenAI 兼容端点（自定义 provider 显式 `base_url` + `model`） |
| 工程 | 三平台 CI（Windows / Linux / macOS）、全局 bin、`stream-json` 管道输出、类型化事件契约 |

## 使用

### TUI 键位与交互

| 键位 | 行为 |
| --- | --- |
| `Enter` | 提交消息 |
| `Shift+Enter` / `Ctrl+J` | 换行（多行输入） |
| 多行粘贴 | bracketed paste，不误提交 |
| `/` | slash 命令补全（`/clear` 清对话与上下文、`/delete` 连 wire 记录一起删、`/compact` 压缩上下文；发现的每个 skill 各占一条 `/<skill-name>`） |
| `y` / `n` / `a` / `esc` | 审批帧回答：允许 / 拒绝 / 本会话始终允许 / 拒绝 |
| `Ctrl+O` | 折叠/展开最近的工具帧 |
| `Ctrl+C` | 退出（干净恢复 raw mode） |

审批规则：工具在注册处自声明审批分类（`ToolDefinition.approval`）——read 类（read_file / list_files / grep / glob / web_search / web_fetch / task_status）自动放行；write 类需确认且路径限工作区内，`.git/**` 与工作区外（含 `~/.mini-agent/`、凭证文件）一律拒绝；command 类走安全 pattern（ls、git status、npm test…）放行、危险 pattern（rm -rf、git push、sudo、git config/reset/clean、git checkout --/.…）直接拒绝；未声明分类的工具（含 task_stop）一律按 confirm 处理。`a` 答本会话不再问——但关键文件（package.json / tsconfig.json / CI 配置 / `.agent.md` 等，见 `docs/dogfood-protocol.md`）写操作强制每次确认，`a` 不入记忆。

命令执行与后台任务：`run_command` 同步执行默认 30s 超时（`timeout_ms` 可调）。`background=true` 启动后台任务，立即返回 `task <id>`、不阻塞 turn——输出持续落盘到 `<会话目录>/tasks/<id>.log`；模型用 `task_status` 轮询、`task_stop` 停止。后台默认超时 600s、并行上限 8、会话结束即回收。后台不改变审批分类：危险 pattern 依旧直接拒绝。

### 配置与凭证

配置文件（JSON）：用户级 `~/.mini-agent/config.json` + 项目级 `<工作区>/.agent.json`；优先级 **env > 项目级 > 用户级 > 订阅 OAuth 兜底（仅 kimi）**。字段：`provider` / `api_key` / `base_url` / `model` / `system_prompt_file` / `context_budget`。`provider` 默认 `kimi`，`openai` 表示 OpenAI 官方端点，其它自定义名表示任意 OpenAI 兼容端点（自定义名需显式 `base_url` + `model`）。系统 prompt 覆盖链：显式 `system_prompt_file` > 项目级 `.agent.md` > 内置默认。启动时 stderr 打印生效来源（脱敏）。

| 变量 | 说明 |
| --- | --- |
| `KIMI_API_KEY` | kimi provider 的 API key。不设置则读 `~/.kimi-code/credentials/kimi-code.json` 里的订阅 OAuth token |
| `KIMI_BASE_URL` / `KIMI_MODEL` | 覆盖 kimi 的 base URL / 模型（默认 `https://api.kimi.com/coding/v1` / `kimi-for-coding`） |
| `OPENAI_API_KEY` | OpenAI 兼容端点的 API key。命中且未显式配置 provider 时，provider 推断为 `openai` |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` | 覆盖兼容端点的 base URL / 模型（同名 `KIMI_*` 存在时优先） |
| `FAKE_LLM=1` | 用预置脚本演示，无需任何凭证 |

会话记录按工作区存放在 `~/.mini-agent/sessions/<工作区>/<会话>.jsonl`；TUI 启动时可选择继续历史会话（恢复上下文与审批记忆）。

### Skills

SKILL.md 按需加载：启动时只把**名称 + 描述**清单追加进系统 prompt；模型需要用某个 skill 时经 `load_skill` 工具取回全文，人也可以在 TUI 里直接输 `/<skill-name>` 注入同样内容。发现路径：项目级 `<工作区>/.agents/skills/<名字>/SKILL.md` + 用户级 `~/.mini-agent/skills/<名字>/SKILL.md`，一层扫描，重名时项目级覆盖用户级。格式：YAML frontmatter 声明 `name`（≤64 字符）与 `description`（≤1024 字符），缺 frontmatter / 不合法 / 没有 `SKILL.md` 的条目静默跳过。空清单不追加 prompt 段、不注册 `load_skill`。

## 架构（接手开发从这里读）

### 两层世界

- **引擎（`src/engine/`）= 算**：turn 状态机、LLM 接入、工具执行、审批规则、wire 持久化。引擎不依赖 TUI，可独立于任何界面跑（print 模式就是它的另一个投影）。
- **TUI（`src/tui/`）= 演**：分层照搬 kimi-code——coordinator 路由输入、controllers 订阅事件流驱动 UI、components 渲染消息块、theme 统一取色。UI 只消费引擎事件，不碰引擎内部状态。
- **事件契约（`src/engine/events.ts`）是唯一通道**：类型化事件（`turn.started` / `assistant.delta` / `tool.call` / `tool.result` / `approval.request` / `turn.ended`…）既驱动 UI，也落 wire 供冷重建。引擎是唯一事实源，UI 是投影。

### 目录结构与 kimi-code 对照

| 玩具 | kimi-code | 职责 |
| --- | --- | --- |
| `src/engine/loop.ts` | `packages/agent-core*/`（loop/step 驱动） | turn 状态机：LLM 流 → 事件 → tool call 回灌 |
| `src/engine/events.ts` | `packages/transcript`（事件契约与回放） | EventBus + 领域事件（引擎↔UI 唯一通道） |
| `src/engine/wire.ts` | session transcript / wire 日志 | append-only 事件落盘（EventSink 保序 + 失败告警容错）+ Rebuilder 双通道冷重建 |
| `src/engine/session.ts` | session storage | 会话按工作区分文件 |
| `src/engine/context.ts` | context window / compaction | 预算高水位触发真压缩（LLM 摘要 + 保留尾部），摘要失败退化为滑动窗口截断 |
| `src/engine/approval/` | permission/approval 规则引擎 | 分级规则 + 会话记忆 + 应答源组合 |
| `src/engine/tools/` | `agent-core/src/tools/` | 内置工具 + 统一输出护栏 |
| `src/bootstrap.ts` | kimi-code 装配段 | 组合根：显式装配 Engine 各部件 |
| `src/tui/app.ts` | `kimi-tui.ts` 装配段 | 组合根：组件树上树 + 控制器接线 |
| `src/tui/coordinator.ts` | `kimi-tui.ts`（协调器，薄） | 输入路由、busy 闸、Ctrl+C |
| `src/tui/controllers/streaming-ui.ts` | `controllers/streaming-ui.ts` | delta 增量更新 Markdown 块、loader 启停 |
| `src/tui/components/messages/` | `components/messages/` | user / assistant / tool-call / thinking / approval 帧 |
| `src/tui/components/chrome/` | `components/chrome/` | welcome / footer / loader |
| `src/tui/theme/` | `theme/` | 颜色 token 单源 + pi-tui 主题适配 + 背景检测 |
| `src/tui/commands/` | `commands/` | slash 声明/解析/执行分离 |
| `vendor/pi-tui/` | `packages/pi-tui` | 终端 UI 库（逐字 vendor，ADR-0002） |

### 一条消息的旅程

`用户提交 → loop.runTurn` 组装 messages → LLM 流式返回（`assistant.delta` / `think` / `tool_call` 事件实时推给 UI）→ 工具调用过审批门（危险直接拒绝）→ `tool.result` 回灌上下文 → 循环直到 `finish`。全程事件进 wire 落盘，进程重启后可冷重建续上。

## 开发

```bash
npm test            # vitest 全量
npm run typecheck   # tsc --noEmit
npm run dev         # 经 tsx 起 TUI（改代码免折腾）
```

CI：GitHub Actions 三平台矩阵（Windows / Linux / macOS），typecheck + 全量测试，push/PR 触发。

### 工作流约定

见 [AGENTS.md](./AGENTS.md)：

- **大变更走 `/implement`**：TDD at 预先约定的接缝 → 单文件测试随写随跑 → 全量测试 → `/code-review` 后提交；小改动可直接实现。
- **每个推送到远端的提交都过 `/code-review`**（固定点 = 父提交或上一远端 head），处理完 findings 再开下一块。
- **milestone 完成后跑架构评审**（`/improve-codebase-architecture`）。
- Issue 用 `gh` CLI 开在 GitHub（见 [docs/agents/issue-tracker.md](./docs/agents/issue-tracker.md)），标签规范见 [docs/agents/triage-labels.md](./docs/agents/triage-labels.md)。

### 文档索引

| 文档 | 内容 |
| --- | --- |
| [Spec-迷你CodingAgent玩具.md](./Spec-迷你CodingAgent玩具.md) | 原始设计：Problem / Solution / 决策 / Out of scope |
| [docs/spec-v2.md](./docs/spec-v2.md) | 拓展路线 v2：A/B 阶段落地情况与验收标准 |
| [docs/acceptance.md](./docs/acceptance.md) | 全部 issue 的验收操作手册 |
| [docs/dogfood-protocol.md](./docs/dogfood-protocol.md) | 自举狗食的安全协议（关键文件保护等） |
| [docs/adr/](./docs/adr/) | 架构决策记录（TypeScript、pi-tui vendor 等） |
| [docs/agents/](./docs/agents/) | 协作规范：issue-tracker / triage-labels / domain |

## Roadmap

- **已完成**：MVP（#1）→ 拓展 v2 A/B 阶段（#13–#50：审批、会话恢复、工具链、上下文、配置、CI、全局 bin）→ 增强批次（#51 后）：真实上下文压缩（#57）、todo 计划（#58）、skills 加载（#59）、后台任务（#61）、diff 预览与 git 感知（#62）、自举安全护栏（#63）。
- **进行中（spec-v3，#51）**：让 mini-agent 真能写代码 + 自举验收——即用本仓库自身的开发作为狗食任务，持续逼近「负责自己开发的 agent」。分支 `spec-v3` 是当前工作线。
- **重议中（#60）**：subagent / 多 agent 是否进入范围。
- **Out of scope（重申）**：MCP / 插件系统、图片/多模态输入、OAuth 自动刷新——超出单会话玩具的体量，真要做画新地图。
