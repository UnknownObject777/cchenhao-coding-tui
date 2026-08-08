# vendor/pi-tui

Vendored copy of `@moonshot-ai/pi-tui` **v0.80.8**, copied 2026-08-08 from
`D:/找工作/kimi-code/packages/pi-tui`（kimi-code monorepo；该目录本身是 upstream pi-mono 0.80.2 的 fork，
含 5 处本地修复，见其 AGENTS.md——拷贝时已原样保留）。MIT，见 `LICENSE`。

决策依据：ADR-0002（`docs/adr/0002-pi-tui-vendor.md`）与 issue #4 调研。

## 包含内容

- `src/**` — 库源码（TS，带 `.ts` 后缀相对导入，tsx / node type-stripping 均可直接跑）
- `native/` — darwin/win32 可选原生模块（静默降级，不崩）
- `test/virtual-terminal.ts` — VirtualTerminal 测试底座（不在包 exports 里，只能相对路径导入）
- `test/test-themes.ts` — 测试主题，仅作我们自建 theme 的参照，不用于生产

## 依赖对应

本仓库 `package.json` 已声明其运行时依赖：`marked@18.0.5`、`get-east-asian-width@1.6.0`；
测试底座另需 devDep `@xterm/headless@5.5.0`；`test-themes.ts` 用 `chalk`。

## 消费约定

- 生产代码只从 `vendor/pi-tui/src/index.ts` 导入（单入口）。
- 测试可导入 `vendor/pi-tui/test/virtual-terminal.ts`。
- **不手改此目录内代码**；要改就走 re-vendor 流程。

## Re-vendor 升级步骤

1. 在 kimi-code 仓库确认 `packages/pi-tui` 新版本及其 AGENTS.md 的本地分歧清单无新增遗漏。
2. 整体替换 `src/`、`native/`、`test/virtual-terminal.ts`、`LICENSE`、`README.md`。
3. 核对新 `package.json` 的 dependencies/devDependencies 是否变化，同步本仓库根 `package.json` 并 `npm install`。
4. 更新本文件头部的版本号与日期。
5. 跑 `npm run typecheck && npm test`，再跑一遍 TUI 冒烟（提交一条消息看视口）。
