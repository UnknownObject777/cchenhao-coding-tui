# 自举 Dogfood 协议（#63 决策）

mini-agent 用它自己开发自己（在本仓库内读写代码、跑测试）时执行的安全协议。代码层面的护栏在 `src/engine/approval/`（规则引擎 + 组合 gate），本文档回答 #63 四问中不落在代码里的部分，并给出每次自举验收的统一执行步骤。

## 1. 保护路径（问 1）

审批规则引擎已 deny 的路径/操作，`--yes` 也无法放行（#27）：

- **写工具**（write_file / edit_file 等，path 参数）：
  - 工作区外一律 deny（含 `~/.mini-agent/` 配置与会话目录、`~/.kimi-code/credentials/` 等凭证文件、`..` 逃逸）；
  - 工作区内 `.git/**` 一律 deny（保护段在 `rules.ts` 的 `PROTECTED_PATH_SEGMENTS`，段名大小写不敏感）。
- **run_command**：`rm -rf`、`git push`、`sudo`、`mkfs`、`del /f /q`、`format`，以及 `git config`（写 `.git/config`）、`git reset`（改 index）、`git clean`（删未跟踪）、`git checkout --` / `git checkout .`（丢弃工作树改动）一律 deny。
- **读操作不设限**：read 类工具自动放行，含读 `.git` 与配置——只保护写/执行。

不做的事：不为 run_command 做全量 shell 路径保护（命令天然可以访问任何路径，穷举 pattern 是兔子洞）。未被 pattern 命中的命令仍走 confirm（问一次），自举会话里对命令的信任边界靠「confirm + diff 预览 + 隔离环境」三层兜住，不在规则引擎里假装能完全拦住 shell。

## 2. 审批升级（问 2）

现有 `y` / `n` / `a` + diff 预览（#62）对自举场景基本够用，只补一条：**关键文件写操作强制 confirm，`a` 也不入会话记忆**（`composed-gate.ts` 的记忆旁路）。

关键文件 = 改了会改变构建/测试门槛或 mini-agent 自身行为的文件，清单在 `rules.ts` 的 `CRITICAL_WRITE_BASENAMES` / `CRITICAL_WRITE_SEGMENTS`：

- `package.json`、`package-lock.json`、`tsconfig.json`（动依赖与类型检查门槛）；
- `.github/**`（CI 配置）；
- `.agent.md`、`AGENTS.md`（系统提示/代理指令——自举时自我改写指令的风险）；
- `.agents/**`（技能）。

对它们的每次写都必须真人/`--yes` 单独确认，答 `a` 只放行本次、下次照问。其余文件维持原语义：`a` 后同 pattern 本会话不再问（#26）。

## 3. 测试门（问 3）

不改代码功能，作为自举协议强制：**任何改动在本仓库落地前必须通过测试门**。

```bash
npm run typecheck   # 必须通过
npm test            # 全量测试必须绿（现有 300+ 用例不能红）
```

- 「完成」的定义包含测试门通过，结果记入本次提交信息与对应 issue 评论；
- 禁止以「改的是文档/注释」为由跳过——typecheck 对文档改动无害且耗时可忽略，全量测试兜住意外回归；
- 测试门失败即任务未完成，不得声称 done。

## 4. 环境隔离（问 4）

狗食（用 mini-agent 开发 mini-agent）**不在本仓库工作区直接进行**，避免污染 `.git`、会话目录与在途改动：

1. **工作副本**：从本仓库另起临时 clone 或 `git worktree add`（例：`git worktree add /tmp/mini-dogfood spec-v3`），在副本里让 mini-agent 改代码、跑测试；
2. **被测版本**：副本里 `npm link`（或把全局 bin 指向副本的 `npm run agent` 入口），确保跑的是被测版本而非已发布旧版；
3. **会话隔离**：工作区路径不同 → 会话文件自动落在 `~/.mini-agent/sessions/<副本路径>/`，与日常使用互不串扰（#30）；需要时可用 `--new` 强制新会话；
4. **收尾**：验收完成后丢弃副本（`git worktree remove` 或删临时目录），改动经正常 PR/提交流程回到主仓库——副本里的改动不要直接推主仓库的 `.git`。

隔离不代替第 1 节的规则：危险 pattern 与保护路径在副本里同样生效，只是把「万一出事」的爆炸半径从主仓库挪到一次性目录。

## 每次自举验收的执行顺序

1. 按第 4 节起隔离副本；
2. 在副本里完成改动（遵守第 1、2 节护栏）；
3. 跑第 3 节测试门，记录结果；
4. 改动经正常流程合并回主仓库后，在 issue 评论补一句测试门结果 + 提交指针。

> 相关实现：#63（本协议与规则扩展）、#62（diff 预览）、#26（会话记忆）、#27（--yes）、#25（规则引擎）、#30（会话按工作区分目录）。
