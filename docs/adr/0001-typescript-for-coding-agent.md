# ADR-0001 · Coding Agent 用 TypeScript 实现

- Status: Accepted
- Date: 2026-08-08
- Related: [Spec-迷你CodingAgent玩具.md](../Spec-迷你CodingAgent玩具.md)

## Context

本仓库的定位是"第一块上手板 + 架构对照物"：用 `@moonshot-ai/pi-tui` 写一个迷你 coding agent 终端应用，引擎部分自写迷你版（loop / llmRequester / toolExecutor / wire），TUI 部分照搬 kimi-code `apps/kimi-code/src/tui/` 的分层骨架。

动手前评估过两个候选语言：**TypeScript** 与 **Rust**。

- 主流 coding agent（kimi-code、Claude Code、Cursor、Gemini CLI、OpenCode）多为 TS 系；OpenAI Codex CLI、Block Goose 选了 Rust。
- TS 的 LLM SDK / TUI（pi-tui、Ink）生态最成熟；Rust 的优势在单二进制分发、高并发与内存占用。
- Rust 对 turn/loop 状态机的类型表达力更强，但会显著拖慢迭代速度。

本项目的目标不是追求性能或分发便利，而是**用最小代码把"agent 引擎 + 真实产品 TUI 组织方式"落到手**，且 kimi-code 本身是 TS——语言选型直接决定"学到的分层知识能否直接迁移"。

## Decision

**全栈采用 TypeScript**：引擎（Loop / LLMRequester / ToolExecutor / WireService）与 TUI（Coordinator / controllers / components / theme）全部用 TS 实现，运行在 Node（pnpm）之上。

配套约定：

- TUI 使用 `@moonshot-ai/pi-tui`，不 fork 不修改，只当依赖消费。
- 引擎零 TUI 依赖，事件契约（EventBus 类型）定义在引擎侧。
- 术语沿用 kimi-code（turn / loop / wire / tool call / streaming-ui / theme），不发明新词。

## Consequences

**正面**

- LLM SDK、流式协议、tool schema 的 JSON 处理在 JS 生态是第一公民，agent loop 的胶水逻辑迭代最快。
- pi-tui / Ink 的 TUI 生态成熟，`VirtualTerminal` 提供现成 UI 测试底座。
- 照搬 kimi-code 分层时，目录形状、职责边界、命名可直接对照，迁移成本最低。
- 引擎与 UI 的事件流模型（AsyncIterable + 判别联合）在 TS 下表达自然。

**负面**

- 分发依赖 Node runtime，无法交付单二进制。
- 高并发 subagent / 大代码库解析等性能敏感场景弱于 Rust。

**后续触发条件**：若未来演进出"单二进制、可分发、吃性能"的诉求（类似 aider / Codex CLI 的定位），可参照 OpenAI Codex CLI"先 TS 后 Rust"的先例，将瓶颈模块单独用 Rust 替换，而不是整体迁移。
