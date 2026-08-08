# ADR-0002: pi-tui 以 vendor 拷贝方式落地

## 状态

已接受（2026-08-08，关闭 #10 时生效）

## 背景

`@moonshot-ai/pi-tui` 未发布 npm，只以 TS 源码形式存在于 kimi-code monorepo（`packages/pi-tui`）。#4 的调研实测了三种消费方式，结论记录于此作为决策依据。

## 决策

采用 **vendor 拷贝**，不用 `file:` 协议、不等待官方发布：

1. 把 pi-tui 的 `src/**` + `native/` + `test/virtual-terminal.ts` + `test/test-themes.ts`（仅作自建 theme 的参照）+ `LICENSE` 拷入本仓库 `vendor/pi-tui/`，保留 MIT 版权头。
2. `marked@18.0.5`、`get-east-asian-width@1.6.0` 声明为本仓库真实 `dependencies`；`@xterm/headless@5.5.0` 声明为 `devDependencies`。
3. 本仓库代码经 `vendor/pi-tui/src/index.ts` 一个入口消费 pi-tui；测试经 `vendor/pi-tui/test/virtual-terminal.ts` 使用 VirtualTerminal（它不在包 exports 里，只能相对路径导入）。
4. 写 `vendor/pi-tui/README.md` 记录来源版本（kimi-code pi-tui v0.80.8）与 re-vendor 升级步骤。

## 理由

- `file:` 是 symlink 而非拷贝，pi-tui 的运行时依赖（marked 等）会沿 realpath 解析进 kimi-code 自己的 pnpm store——运行时依赖押在「kimi-code 仓库存在且已 pnpm install」上，CI/换机必挂（#4 实测）。
- vendor 后 hermetic：`npm install && npm test` 自包含，CI 安全。
- 代价是失去上游自动更新；用 README 里的 re-vendor 流程兜底，玩具项目可接受。

## 与 ADR-0001 的关系

ADR-0001 约定 pi-tui「不 fork 不修改，只当依赖消费」。本 ADR 不改变该约定的语义：vendor 是**消费方式**（逐字拷贝、不手改，见后果一节），不是 fork；ADR-0001 的「不修改」约束继续生效，由「不手改 vendor 目录」落实。

## 后果

- `vendor/` 目录进入版本库，不参与本仓库 tsconfig 的类型检查严格度要求之外的重构；除 re-vendor 外不手改其中代码。
- 后续「MVP 完成后不大规模搬代码」的约束同样适用于 vendor 目录：位置一旦定下不再迁移。
- 配套 tsconfig 调整（2026-08-08 随 #14 落地）：`target`/`lib` 升到 ES2024（vendor `utils.ts` 使用 `v` flag 正则），关闭 `exactOptionalPropertyTypes`（vendor 源码不满足该 flag，且禁止手改）。
