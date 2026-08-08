# cchenhao-coding-tui

迷你 coding agent 玩具：引擎自写（loop / llmRequester / toolExecutor / wire），TUI 分层照搬 kimi-code。目标是"第一块上手板 + 架构对照物"——详见 [Spec-迷你CodingAgent玩具.md](./Spec-迷你CodingAgent玩具.md) 与 [docs/adr/0001](./docs/adr/0001-typescript-for-coding-agent.md)。

当前进度：**MVP（引擎 + `-p` print 模式）已完成**（[issue #1](https://github.com/UnknownObject777/cchenhao-coding-tui/issues/1)）。交互式 TUI 是后续 milestone。

## 使用

要求 Node ≥ 22.19（`agent` bin 依赖 Node 原生 TypeScript type-stripping）。

```bash
npm install

# 真实模型（默认走 Kimi Code 订阅）
node src/cli/main.ts -p "在当前目录写一个 hello.js，打印 hello world"

# 无凭证演示（预置脚本，不调 API）
FAKE_LLM=1 node src/cli/main.ts -p "演示一下"
```

`-p` print 模式：assistant 回复写 stdout，工具帧（tool.call / tool.result）写 stderr，全程事件追加到当前目录的 `wire.jsonl`。

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
npm test            # vitest 全量（22 个测试，引擎完全 headless）
npm run typecheck   # tsc --noEmit
npm run agent -- -p "..."   # 经 tsx 运行（开发时改代码免折腾）
```

### 结构

```
src/
├── bootstrap.ts            # 组合根：显式装配引擎各部件
├── cli/
│   ├── main.ts             # 入口：-p → print 模式（类比 kimi-code main.ts 分叉）
│   └── run-prompt.ts       # print 驱动：事件 → stdout/stderr
└── engine/                 # 零 TUI 依赖，headless 可测
    ├── events.ts           # EventBus + 领域事件契约（引擎与 UI 唯一通道）
    ├── loop.ts             # turn 状态机：LLM 流 → 事件 → tool call 回灌
    ├── llm/
    │   ├── types.ts        # ModelEvent 判别联合 / Message / LLMRequester 接口
    │   ├── fake.ts         # 预置脚本假 LLM（测试与演示）
    │   ├── kimi.ts         # 真实实现：OpenAI 兼容 SSE 流
    │   ├── kimi-stream.ts  # SSE chunk → ModelEvent 转换器（纯函数可测）
    │   └── credentials.ts  # KIMI_API_KEY 或 kimi-code 订阅 OAuth token
    ├── tools/
    │   ├── executor.ts     # 工具注册表 + 执行 + 结构化错误结果
    │   └── builtins.ts     # read_file / write_file / run_command（超时杀进程树）
    └── wire.ts             # append-only wire.jsonl + Rebuilder 冷重建
test/                       # 接缝测试：loop 事件序 / toolExecutor / wire 往返 / SSE 转换器
```

### 工作流约定

见 [AGENTS.md](./AGENTS.md)：大变更走 `/implement`（TDD at 预先约定的接缝 → 全量测试 → `/code-review` 后提交）；每个推送到远端的提交都要过 `/code-review`；milestone 完成后跑 `/improve-codebase-architecture`。Issue 用 `gh` CLI 开在 GitHub 上（见 [docs/agents/issue-tracker.md](./docs/agents/issue-tracker.md)）。

## Out of Scope（本阶段）

pi-tui TUI 分层骨架、slash 命令、OAuth 自动刷新、鉴权重试、上下文压缩、多 agent——见 spec 的 Out of Scope 一节。
