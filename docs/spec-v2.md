# 拓展路线 spec v2

> 落地票：#13。本文把地图（#2）的所有决策票结论回写成可执行路线。
> 状态：A/B 两阶段均已实施完成（2026-08-09）。

## 前提：已锁定的框架决策（#2 Notes）

- 先 A 后 B，最终形态是每周真用的工具；使用场景 = 小型个人项目/脚本任务。
- Provider 走轻量路线：任何 OpenAI 兼容端点，env + 本地配置文件即可，不做重抽象。
- 审批 = 分级规则（安全 pattern 自动放行/危险强制确认或拒绝）+ 会话级「始终允许」记忆；不做工作区信任文件、不做命令改写建议。
- B 阶段最小集必须含真实 agent 的标准工具链（web search/fetch、文件检索等"该有的都有"）。

## A 阶段：pi-tui TUI 分层骨架（已完成）

依赖落地：vendor 拷贝（ADR-0002，`vendor/pi-tui/`，含 VirtualTerminal 测试底座）。

切分与验收点（#11 决策）：

1. **theme**（#14）：颜色 token 单源 + pi-tui Markdown/Editor 主题适配。
2. **消息块组件**（#15）：user/assistant/tool-call + VirtualTerminal 行为测试。
3. **streaming-ui + chrome**（#16）：delta 增量更新、loader 启停、footer/welcome。
4. **coordinator + editor + slash**（#17）：输入路由、/clear /delete、Ctrl+C。
5. **端到端**（#18）：bootstrap 装配 Engine→TUI，`npm run dev` 一键启动，fake/真实 LLM 双路。

增强批次（全部完成）：welcome/banner（#19）、think 折叠渲染（#20）、slash 补全（#21）、多行键位（#22）、暗/亮主题检测（#23）、工具帧折叠/展开（#24）。

## B 阶段：每周真用最小集（已完成）

### 审批（#5 决策 → #25–#28，#12 原型并入 #28）

- 事件契约：`approval.request`（gate 侧，带规则级别）/ `approval.decision`（loop 侧），进 wire 可重放。
- loop 暂停方式：注入异步 `ApprovalGate`，`tool.call` 发布后、`execute` 前 await；EventBus 保持单向。
- 规则引擎：`engine/approval/rules.ts` 表驱动（allow/confirm/deny）；危险 pattern 与跨工作区写直接 deny。
- 会话记忆：`always` 按「工具名 + 首字符串参数前两段」记忆，会话级内存；恢复时从 wire 回放。
- print 模式：`--yes` 放行写/执行，危险拦截不绕过；TUI 模式：消息区内联审批帧，y/n/a/esc。

### 会话恢复（#6 决策 → #29/#30，选择器 #47）

- 冷重建**进上下文**：wire 事件完整记录 tool 配对，协议形状可还原（assistant.toolCalls / tool.toolCallId）；中断会话合成占位 tool 回复保配对。
- 双通道：Rebuilder.rebuild（UI 展示）/ rebuildForContext（LLM 上下文）。
- 会话文件按工作区组织：`~/.mini-agent/sessions/<slug+hash>/<id>.jsonl`；TUI 启动选择器（续/新建），`--new` 强制新会话；print 不恢复。

### 上下文溢出（#7 决策 → #31/#32）

- 滑动窗口：保 system + 最近消息，tool 配对整组同进退；chars/4 粗估；80% 触发截到 60%；仍超则报错引导 /clear。
- token 用量经 `context.usage` 事件上 footer，≥70% 警示色。

### 工具链（#8 决策 → #33–#37）

8 个内置工具：read_file / write_file / run_command / list_files / grep / glob / web_search / web_fetch。纯 Node 实现；输出护栏在 ToolExecutor 一次收口（50KB/2000 行 + `[...truncated]`）；web 工具接订阅 search/fetch 端点，超时 15s/30s，认证错误不重试。

### 配置（#9 决策 → #38/#39）

- JSON 双级：用户级 `~/.mini-agent/config.json` + 项目级 `.agent.json`；优先级 env > 项目级 > 用户级 > OAuth 兜底。
- 字段：api_key / base_url / model / system_prompt_file；启动打印生效来源（脱敏）。
- 系统 prompt：显式文件 > 项目级 `.agent.md` > 内置默认。

### 工程与发布

- 引擎健壮性：错误分类（#40）、有限重试（#41）、wire 坏行容错（#42）。
- CI 三平台矩阵（#43）+ 跨平台验证与差异表（#44）。
- 全局 bin：`mini-agent`（npm link，Node type-stripping 直跑 .ts）（#45）。
- `--output-format stream-json`（#46）；footer 状态栏（#48）；README TUI 篇与架构对照（#49）。

## 验收标准

**作者一周内用它完成 ≥3 个真实小任务**（记录 prompt、卡点、体感）——执行票 #50，完成后地图 #2 收图。

## Out of scope（重申）

subagent / 多 agent、MCP / 插件系统、真正的上下文压缩（compaction）、图片/多模态输入。超出一个 session 级玩具的体量，真要做画新地图。
