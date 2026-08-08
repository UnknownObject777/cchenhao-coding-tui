# cchenhao-coding-tui

迷你 coding agent 玩具：引擎自写（loop / llmRequester / toolExecutor / wire），TUI 分层照搬 kimi-code。目标是"第一块上手板 + 架构对照物"——详见 [Spec-迷你CodingAgent玩具.md](./Spec-迷你CodingAgent玩具.md)（v2 路线见 [docs/spec-v2.md](./docs/spec-v2.md)）与 [docs/adr/](./docs/adr/)。

当前进度：**B 阶段「每周真用最小集」已落地**——TUI、审批、会话恢复、标准工具链、配置文件、上下文窗口、CI、全局 bin 全部完成（issues #1–#48）。

## 使用

要求 Node ≥ 22.19（bin 依赖 Node 原生 TypeScript type-stripping）。

```bash
npm install
npm link          # 全局可用：mini-agent

mini-agent                 # 交互式 TUI（有历史会话会先出选择器）
mini-agent --new           # 强制新会话
mini-agent -p "任务"        # print 模式（一次性，stdout 出结果）
mini-agent -p --yes "任务"  # print 模式放行写/执行类工具调用
mini-agent -p "任务" --output-format stream-json   # 事件逐行 JSON（管道消费）
```

无凭证演示：`FAKE_LLM=1 mini-agent`（预置脚本，不调 API）。

### TUI 键位与交互

| 键位 | 行为 |
| --- | --- |
| `Enter` | 提交消息 |
| `Shift+Enter` / `Ctrl+J` | 换行（多行输入） |
| 多行粘贴 | bracketed paste，不误提交 |
| `/` | slash 命令补全（`/clear` 清对话与上下文、`/delete` 连 wire 记录一起删） |
| `y` / `n` / `a` / `esc` | 审批帧回答：允许 / 拒绝 / 本会话始终允许 / 拒绝 |
| `Ctrl+O` | 折叠/展开最近的工具帧 |
| `Ctrl+C` | 退出（干净恢复 raw mode） |

审批规则（#25）：只读工具（read_file / list_files / grep / glob / web_search / web_fetch）与安全命令 pattern（ls、git status、npm test…）自动放行；危险 pattern（rm -rf、git push、sudo、写工作区外）直接拒绝；其余问一次，`a` 答本会话不再问。

### 配置

配置文件（JSON）：用户级 `~/.mini-agent/config.json` + 项目级 `<工作区>/.agent.json`；优先级 **env > 项目级 > 用户级 > 订阅 OAuth 兜底**。字段：`api_key` / `base_url` / `model` / `system_prompt_file`。系统 prompt 覆盖链：显式 `system_prompt_file` > 项目级 `.agent.md` > 内置默认。启动时 stderr 打印生效来源（脱敏）。

会话记录按工作区存放在 `~/.mini-agent/sessions/<工作区>/<会话>.jsonl`；TUI 启动时可选择继续历史会话（恢复上下文与审批记忆）。

### 凭证与环境变量

| 变量 | 说明 |
| --- | --- |
| `KIMI_API_KEY` | 直接用 API key。不设置则读 `~/.kimi-code/credentials/kimi-code.json` 里的订阅 OAuth token |
| `KIMI_BASE_URL` | 覆盖 base URL（默认 `https://api.kimi.com/coding/v1`） |
| `KIMI_MODEL` | 覆盖模型（默认 `kimi-for-coding`） |
| `FAKE_LLM=1` | 用预置脚本演示，无需任何凭证 |

注意：订阅 OAuth token 有效期约 15 分钟，过期后先跑一次 `kimi` 刷新登录态（玩具不做自动刷新），或改用 `KIMI_API_KEY`。

## 开发

```bash
npm test            # vitest 全量
npm run typecheck   # tsc --noEmit
npm run dev         # 经 tsx 起 TUI（开发时改代码免折腾）
```

CI：GitHub Actions 三平台矩阵（Windows / Linux / macOS），typecheck + 全量测试，push/PR 触发。

### 结构与 kimi-code 对照

本玩具与 kimi-code 真实仓库（`apps/kimi-code/src/tui/`、`packages/`）的目录对照：

| 玩具 | kimi-code | 职责 |
| --- | --- | --- |
| `src/engine/loop.ts` | `packages/agent-core*/`（loop/step 驱动） | turn 状态机：LLM 流 → 事件 → tool call 回灌 |
| `src/engine/events.ts` | `packages/transcript`（事件契约与回放） | EventBus + 领域事件（引擎↔UI 唯一通道） |
| `src/engine/wire.ts` | session transcript / wire 日志 | append-only 事件落盘 + Rebuilder 双通道冷重建 |
| `src/engine/session.ts` | session storage | 会话按工作区分文件 |
| `src/engine/context.ts` | context window / compaction | 滑动窗口截断（玩具无真压缩） |
| `src/engine/approval/` | permission/approval 规则引擎 | 分级规则 + 会话记忆 + 应答源组合 |
| `src/engine/tools/` | `agent-core/src/tools/` | 内置工具 + 统一输出护栏 |
| `src/tui/app.ts` | `kimi-tui.ts` 装配段 | 组合根：组件树上树 + 控制器接线 |
| `src/tui/coordinator.ts` | `kimi-tui.ts`（协调器，薄） | 输入路由、busy 闸、Ctrl+C |
| `src/tui/controllers/streaming-ui.ts` | `controllers/streaming-ui.ts` | delta 增量更新 Markdown 块、loader 启停 |
| `src/tui/components/messages/` | `components/messages/` | user / assistant / tool-call / thinking / approval 帧 |
| `src/tui/components/chrome/` | `components/chrome/` | welcome / footer / loader |
| `src/tui/theme/` | `theme/` | 颜色 token 单源 + pi-tui 主题适配 + 背景检测 |
| `src/tui/commands/` | `commands/` | slash 声明/解析/执行分离 |
| `vendor/pi-tui/` | `packages/pi-tui` | 终端 UI 库（逐字 vendor，ADR-0002） |

### 工作流约定

见 [AGENTS.md](./AGENTS.md)：大变更走 `/implement`（TDD at 预先约定的接缝 → 全量测试 → `/code-review` 后提交）；每个推送到远端的提交都过 `/code-review`；milestone 完成后做架构评审。Issue 用 `gh` CLI 开在 GitHub 上（见 [docs/agents/issue-tracker.md](./docs/agents/issue-tracker.md)）。全量验收步骤见 [docs/acceptance.md](./docs/acceptance.md)。

## Out of Scope

subagent / 多 agent、MCP / 插件系统、真正的上下文压缩（compaction）、图片/多模态输入、OAuth 自动刷新——见 spec v2 的 Out of scope。
