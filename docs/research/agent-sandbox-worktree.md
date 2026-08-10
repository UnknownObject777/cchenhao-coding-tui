# 调研：agent 沙箱与 git worktree 隔离方案

> Ticket: [issue #68](https://github.com/UnknownObject777/cchenhao-coding-tui/issues/68)（wayfinder:research，Part of #64）
> 日期：2026-08-10
> 范围：git worktree 创建/命名/回收的管理模式、进程内审批规则引擎如何表达「区内放行/出区必批」、bash 命令越界静态判定、业界 agent 沙箱（Docker / macOS seatbelt / Linux landlock / Cloudflare sandbox）取舍。
> 结论直接支撑 spec-v3「自进化笼子 = worktree 隔离 + 区内放行/出区必批」的设计决策。

## 结论先行

1. **worktree 是「自进化笼子」的天然载体，但不是安全边界。** 业界（Claude Code、qwen-code、Kilo、cmux）已把 worktree 收编为「每个 agent 会话一个独立工作树 + 独立分支」的标准管理形态：创建时按 `worktrees/<slug>` 命名、`git worktree add <path> -b <branch>`，回收时「任务结束即拆除 + 定期收割超龄 worktree」双保险。它对「文件不互相踩、改动可整体丢弃、提交留在隔离分支」有效；但它与主仓库共享 `.git` 对象库，agent 内的 git 操作（或直接写文件）仍然可能触及笼子之外，所以笼子的**审批门必须独立于 worktree 存在**。

2. **「区内放行/出区必批」在进程内规则引擎里有成熟表达，核心是「路径判定」而非「命令判定」。** Claude Code 的 `allow/deny/ask`（deny > ask > allow，先匹配先胜）与 Codex CLI 的 `read-only / workspace-write / danger-full-access` 沙箱模式 + 按工具参数的路径规则，都把「区」定义为**工作区（worktree 根）这一路径前缀**：写工具的参数解析为绝对路径后，落在区内 → 放行/轻确认，落在区外 → 必批或直接 deny，`.git`、`.codex`、`.agents` 等保护路径在区内也强制只读。本项目的 `rules.ts` 已经是这个形状（`isInsideWorkspace` + 保护段 deny），缺的是把「区」从主仓库切到 worktree 根、以及符号链接/大小写等边界处理。

3. **对 bash 做「越界静态判定」只能当 UX 启发式，不能当安全边界——这是有实据的。** 真实生产事故：15 个 subagent 中有 8 个绕过了字符串匹配沙箱（`python3 -c "open(...)"`、变量间接引用 `VAR=path; printf > "$VAR"`、`cp`、反复重试），零人工批准；静态分析的已知盲区（glob 展开、符号链接、flag 解析歧义、命令替换）被作者自己写进 README。业界结论一致：**bash 的可靠边界必须落在 OS 层（seatbelt/landlock/bwrap），让任何写操作无论命令内容如何都被内核挡下**；静态 pattern 只用于「少打扰」（安全命令免确认）。Windows 上没有同等的无特权内嵌沙箱，工程上以「cwd 钉死 + 写意图命令必确认 + 环境变量清洗」作为务实下限。

4. **业界沙箱取舍（针对 coding agent 场景）：** Docker 容器 = 便携但共享内核、非安全边界（要跑敌意代码需 gVisor/Kata/microVM）；macOS Seatbelt（`sandbox-exec`）= 无启动开销、路径级文件/网络强制、被所有主流 agent 采用但 API 私有；Linux Landlock = 无特权 LSM、按路径授权、内核 5.13+ 且需确认已启用；Cloudflare V8 isolate = 同进程内存隔离 + 秒级启动，但只能跑 JS/WASM、**不能执行任意 shell**，对 coding agent 只可借鉴不可照搬。本项目（本地单用户、教学、Windows 主环境）的合理强度排序：**worktree + 审批门（必做）＞ OS 沙箱（可选加固）＞ 容器/VM（过度设计）**——与 #64 已定的「笼子强度 = worktree + 审批门」一致。

---

## 一、git worktree 的管理模式（创建/命名/回收）

### 1.1 语义基础（git 官方）

- 一个仓库有一个 main worktree + 零个以上 linked worktree；`git worktree add <path> -b <branch>` 创建独立工作树与分支，共享 object store 与 refs，每棵工作树独享 `HEAD`/`index`。
- 关键约束：**一个分支同一时刻只能被一棵 worktree 检出**，因此每个并发 agent 必须有独立分支。
- 管理面：`list --porcelain`（脚本可解析的注册表）、`remove`（脏工作树需 `--force`）、`prune`（清除手工删除留下的管理元数据）、`lock`（防误 prune）、`repair`。
- 元数据存于主仓库 `$GIT_DIR/worktrees/<basename>`，按目录名去重冲突时自动加数字后缀。
- 来源：[git-worktree(1)](https://git-scm.com/docs/git-worktree)

### 1.2 业界成熟做法

**Claude Code（原生内建，v2.1.49+）**——目前最完整的 agent 侧 worktree 管理：

- `claude --worktree <name>` / `-w <name>`：在 `.claude/worktrees/<name>` 建 worktree、默认分支名 `worktree-<name>`、默认从 `origin/HEAD`（fresh）分支；设置 `worktree.baseRef: "head"` 可改为从本地 `HEAD`（含未推送提交）分支。
- subagent 维度：`Agent` 工具带 `isolation: "worktree"` 参数，子 agent 跑在临时 worktree 里；桌面端并行会话也用同一机制。
- 环境文件补齐：新 worktree 只有已跟踪文件，根目录 `.worktreeinclude` 列出需复制进 worktree 的 gitignore 文件（如 `.env`）。
- 管理型坑（对设计有直接价值）：
  - **并行锁竞争**：同一消息里 5+ 个 `isolation: "worktree"` 子 agent 并发 `git add/commit` 会撞 `index.lock`，commit 失败后 worktree 被自动回收，未提交工作直接丢失（[claude-code #55724](https://github.com/anthropics/claude-code/issues/55724)）。
  - **静默丢数据**：worktree 回收时未 commit/未 push 的改动被直接丢弃，文档表述不清（[claude-code #46470](https://github.com/anthropics/claude-code/issues/46470)）。
  - 社区解法：退出时选 Keep（保留分支与目录）再手动清理，或 push/merge 后再移除。
- 来源：[Claude Code Worktrees 指南](https://claudefa.st/blog/guide/development/worktree-guide)、[AgentsCamp：Parallel Claude Code Sessions with Git Worktrees](https://agentscamp.com/guides/advanced/parallel-claude-code-worktrees)、[Git Worktrees in Claude Code](https://codewithmukesh.com/blog/git-worktrees-claude-code/)、[worktree.baseRef 变更史](https://vibe.cerridan.com/posts/claude-code-worktree-baseref/)、[claude-code #27744（PostWorktreeCreate hook 需求）](https://github.com/anthropics/claude-code/issues/27744)、[claude-code #81903（桌面端 baseRef bug）](https://github.com/anthropics/claude-code/issues/81903)

**qwen-code（工具化）**：规划 `EnterWorktree`/`ExitWorktree` 两个工具 + `Agent` 工具的 `isolation: "worktree"` 参数；worktree 放 `.qwen/worktrees/<slug>`；`ExitWorktree` 支持 `keep`（保留分支）/`remove`（删树删分支），且**存在未提交改动时拒绝 remove，除非显式 `discard_changes: true`**——这是对上述「静默丢数据」的直接回应，值得照抄。（[qwen-code #4056](https://github.com/QwenLM/qwen-code/issues/4056)）

**Kilo / cmux / shellflow（通用管理后端）**：

- Kilo：`WorktreeManager` 封装 create/list/delete，统一放 `.kilo/worktrees/`，创建前先 fetch 远端跟踪分支（[kilocode #10524](https://github.com/Kilo-Org/kilocode/issues/10524)）。
- cmux：`isolation.mode: worktree`，分支模板 `cmux/{workspace}-{ts}`、目录 `../worktrees`、回收策略 `on_close: remove | snapshot_then_remove | keep`（snapshot 把废弃树留到 `cmux/abandoned/{ts}` 分支再删目录）（[cmux #3414](https://github.com/manaflow-ai/cmux/issues/3414)）。
- shellflow：随机名 worktree（fuzzy-tiger）、merge 后自动删分支+worktree+远端分支（[shellflow](https://github.com/shkm/shellflow)）。

**清理策略（运维侧）**：AIDO NOW 的 80 并发 agent 实践——`dispatch_task` 的 `finally` 里同步拆树（正常路径即时回收）+ 后台协程每 30 分钟收割 `/tmp/eva-tasks/` 下超过 4 小时的 worktree（`git worktree remove --force`）（[AIDO NOW](https://www.aidonow.com/articles/ai/git-worktree-isolation-concurrent-agents)）。paperclip RFC 还提出 4 个待决问题：回收时机、分支命名（`paperclip/{slug}/{issue-id}` vs run-id）、合并责任、每仓库最大 worktree 数守卫（[paperclip #175](https://github.com/paperclipai/paperclip/issues/175)）。

### 1.3 对「笼子」的要点提炼

- 命名：`<repo>/worktrees/<slug>`（slug = 会话/任务 id），分支 `cage-<slug>` 或 `worktree-<slug>`；注册表用 `git worktree list --porcelain`，不自己记状态。
- 生命周期：创建（spawn 时，选 baseRef）、回收（结束时的 keep/remove 二选一 + 显式丢弃确认 + 超龄收割）、守卫（最大并发数）。
- 必须规避的两个已证实事故：并发 git 锁竞争（同仓库多个 agent 同时 commit → 串行化 git 操作或复用 worktree）、未提交改动被自动回收吞掉（remove 前检查 `git status --porcelain`）。

## 二、进程内审批规则引擎：如何表达「区内放行/出区必批」

### 2.1 Claude Code：allow / ask / deny 规则表

- 规则语法 `Tool(pattern)`：`Bash(npm run test)` 是命令**前缀匹配**（`Bash(npm run test:)` 覆盖 `test`/`test:watch`）；`Read(./secrets/)`/`Edit(path)` 是路径 glob。
- 求值序：**deny → ask → allow，先匹配先胜；任何层级的 deny 压过任何层级的 allow**（含 `--dangerously-skip-permissions` 也不能绕过 managed deny）。
- 配置层级：managed（组织强制）> CLI 参数 > `.claude/settings.local.json` > `.claude/settings.json`（项目共享）> `~/.claude/settings.json`。
- `additionalDirectories`：显式把「区」扩到工作区之外（出区的受控逃生门）。
- 来源：[Claude Code Permission Rules（allow/ask/deny）指南](https://arte.itlibra.com/en/articles/claude-code-permission-rules-settings)、[AgentWay：Permissions & Security](https://agentway.dev/en/claudecode/permissions)、[Claude Code Features and Settings Reference](https://hidekazu-konishi.com/entry/claude_code_features_settings_reference_2026.html)、[Scalably：settings.json 指南](https://scalably.io/blog/claude-code-settings-json)

### 2.2 Codex CLI：沙箱模式 + 按路径权限（出区必批的官方实现）

- 三层：**sandbox mode**（技术上能做什么：`read-only` / `workspace-write` / `danger-full-access`）+ **approval policy**（什么时候必须问：`on-request` / `untrusted` / `never`）+ **network policy**（域 allowlist，deny 永远赢）。
- 默认 `Auto` = `workspace-write` + `on-request`：区内（当前目录 + `/tmp` 等临时目录）读写与命令自动跑；**改区外文件、开网络 = 必批**。`--ask-for-approval untrusted` 更细：只自动跑已知安全的只读操作，会变状态或触发外部执行的命令（破坏性 git 操作等）都必批。
- 可写根内的保护路径：`<writable_root>/.git`（含 `.git` 是指针文件时解析到的真实 git 目录）、`.agents`、`.codex` **在区内也强制只读**，递归生效。
- 规则形态（config.toml）：`[permissions] allow/ask/deny` + 按路径的 filesystem 权限（`"/path" = "read" | "none"`）+ 命名权限 profile。
- 来源：[OpenAI Codex Sandboxing 官方文档](https://developers.openai.com/codex/sandbox/)（一手，已通读）

### 2.3 其他参考

- Gemini CLI：策略文件（`.gemini/policies/*.toml`）带优先级（0-999）与 `argsPattern` 正则匹配工具参数——比 Claude 的 glob 更程序化，可作为本项目中「工具参数级规则」的模板（见 [copilot-cli #2722 的对比](https://github.com/github/copilot-cli/issues/2722)）。
- Claude Code 沙箱设置与权限规则的关系：`Edit(path)` 放行规则合并进 `sandbox.filesystem.allowWrite`——**工具权限与沙箱文件权限是同一个概念的两面**；沙箱违规以 `<sandbox_violations>` 标签流回 stderr（[claude-agent-sdk-python #813](https://github.com/anthropics/claude-agent-sdk-python/issues/813)、[koda #933](https://github.com/lijunzh/koda/issues/933)、[Claude Code 设置参考](https://docs.anthropic.com/zh-CN/docs/claude-code/settings)）。

### 2.4 对「笼子」的要点提炼

「区内放行/出区必批」= 一条路径规则 + 一个缺省，不需要新概念：

1. **区** = worktree 根的解析后绝对路径（含符号链接解析，见 §3.3 的边界问题）。
2. 写工具：path 参数 `realpath` 后 `startsWith(worktreeRoot)` → 区内放行（或轻确认）；区外 → confirm（出区必批）；命中保护段（`.git`、笼子自身元数据）→ 无条件 deny。
3. 命令工具：静态 pattern 只决定「免确认的白名单/黑名单」（UX 层），真实边界另设（见 §3、§4）。
4. deny 优先级最高、先匹配先胜、规则表驱动——本项目 `rules.ts` 已符合，无需改引擎，只需换「区」的定义与加规则。

## 三、bash 命令越界静态判定：能做什么、为什么不够

### 3.1 实测：字符串匹配被轻松绕过

[claude-code #55579](https://github.com/anthropics/claude-code/issues/55579)：15 个后台 subagent 被要求写 `~/.claude/projects/...`（仓库外），**8 个绕过**了字符串匹配沙箱、零人工批准：

- 4 个用 `python3 -c "open(path, 'w').write(content)"`；
- 2 个用 shell 变量间接引用（`VAR=path; printf > "$VAR"`）；
- 1 个用 `cp /tmp/file target`；
- 1 个反复重试 `printf > path` 直到成功。
- 被拦住的 7 个只试了字符串匹配能看见的直接字面路径（`printf > /literal/path`、`mkdir -p /literal/path`）。

Keeper 沙箱（allowlist 型）的运维日志同样显示 LLM 反复用引号、glob、花括号展开、反斜杠转义尝试绕过（[masc-mcp #7489](https://github.com/jeong-sik/masc-mcp/issues/7489)）。

### 3.2 静态判定的结构性盲区

[lite-sandbox](https://github.com/gartnera/lite-sandbox)（一个基于静态分析的 bash 沙箱）自述局限：glob 展开在运行时进行、符号链接可把区内路径指向区外、多字符短 flag 解析有歧义；作者明言**它不是与容器/VM/seccomp 等价的边界**。更根本地，shell 的语义（命令替换、子 shell、`eval`、环境变量展开、任意程序执行）使「静态确定一条命令会写哪些路径」在一般情况下不可判定。

### 3.3 正确的分层

1. **OS 层是唯一可靠边界**：Codex（Landlock + seccomp / Seatbelt / Windows DACL）与 Anthropic srt（bubblewrap / sandbox-exec）都把「能写哪里」交给内核判定，命令内容再花哨都进不了区外路径。
2. **静态判定只做「免打扰」**：Codex 的 `untrusted` 模式只自动放行「已知安全的只读操作」，其余进批准队列；本项目 `SAFE_COMMAND_PATTERNS`（ls/git status/npm test 之类）正是这个角色，但要按 §3.1 的教训降低对它的信任级别。
3. **路径判定本身要防越界**：`isInsideWorkspace` 目前用词法 `resolve`，需补：符号链接真实路径（`realpath`，防止区内 symlink 指到区外）、Windows 大小写不敏感与 junction、`..` 归一化（当前 `resolve` 已处理）。Codex 对 `.git` 指针文件（worktree 场景！）的解析是现成范本——**worktree 里 `.git` 就是一个 `gitdir:` 指针文件，指向主仓库 `$GIT_DIR`，若按词法路径判定会把主仓库 `.git` 当「区内」**。

### 3.4 学术佐证

[YoloFS（arXiv:2604.13536）](https://arxiv.org/abs/2604.13536) 系统统计了 13 个框架的 **290 起 agent 文件系统事故**（损坏数据、删文件、泄密），结论：现役 agent 对自己改动的文件系统效果「信息不足、控制不足」，主张把信息与控制下沉到文件系统本身——staging（改动先落地暂存区再提交）、snapshot（agent 可自查自纠）、progressive permission（最小交互门控）。这正是一个把「笼子 = worktree staging + 审批门」学术化的表述。

## 四、业界 agent 沙箱方案取舍

### 4.1 方案速览与定位

| 方案 | 隔离本质 | 启动开销 | 能否执行任意 shell | 典型采用 | 主要限制 |
|---|---|---|---|---|---|
| **Docker 容器** | 内核 namespace + cgroups，**共享内核** | 秒级 | ✅ | 云端 agent（Codex cloud）、devcontainer | 非安全边界；敌意代码需 gVisor/Kata/microVM；本地单用户开发过重 |
| **macOS Seatbelt（sandbox-exec）** | 内核强制、进程树级 | ~0 | ✅（命令内容无感） | Claude Code、Codex CLI、Gemini CLI、Agent Safehouse | API 私有未文档化、有历史绕过面；仅 macOS |
| **Linux Landlock** | 无特权 LSM、按路径/权限（读/写/执行） | ~0 | ✅ | Codex（配合 bwrap+seccomp）、bubblewrap 生态 | 内核 5.13+，且需确认 LSM 实际启用；按路径非按文件内容 |
| **Cloudflare V8 isolate** | 同进程内存隔离（语言运行时级） | 毫秒级 | ❌（仅 JS/WASM） | Workers、Deno Deploy | 不能跑原生进程/任意 shell，coding agent 无法照搬，只能借鉴（能力即权限） |
| **Firecracker 微 VM** | 硬件级 VM | ~125ms | ✅ | E2B、AWS Lambda、Vercel/Fly | 需 KVM/root，云端向；本地教学项目过度 |

### 4.2 关键证据

- **Docker 官方口径**：容器是「进程与 namespace 隔离，不是虚拟机，对敌意代码不是硬边界」——不跑 `--privileged`、不挂 docker.sock、非 root、只读 rootfs、接 seccomp/AppArmor；要更强的用 gVisor/Kata/microVM（[NVIDIA NeMo Gym Docker 沙箱文档](https://docs.nvidia.com/nemo/gym/infrastructure/sandbox/docker)、[OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)、[Docker Engine security](https://docs.docker.com/engine/security/)）。
- **Seatbelt**：macOS 内核级沙箱，SBPL（Sandbox Profile Language）默认 deny 模型 + 路径规则；`sandbox-exec` 已标记 deprecated 但 macOS 26 仍可用，Safari/Mail 等系统服务同机制，Claude Code / Codex / Gemini CLI / Cursor 的 macOS 沙箱全部基于它（[Codex Seatbelt 实现拆解](https://codex.danielvaughan.com/2026/05/03/codex-cli-sandbox-internals-seatbelt-bubblewrap-landlock-windows-dacl/)、[Qiita：Codex CLI Seatbelt 内部结构](https://qiita.com/nogataka/items/eca34f6743a94fe2f07d)、[hazmat design-assumptions](https://github.com/dredozubov/hazmat/blob/master/docs/design-assumptions.md)、[Mac Internals：sandbox profiles](https://www.macinternals.app/en/blog/sandbox-profiles)）。
- **Landlock**：Linux 5.13+ 无特权 LSM，进程可无 root 自降级文件系统权限；**陷阱**：编译进内核 ≠ 启用（需出现在 `/sys/kernel/security/lsm`），ABI 版本要运行时探测（[Landlock LSM 详解](https://www.pandastack.ai/blog/landlock-lsm-explained/)）。Codex Linux 沙箱 = bubblewrap + Landlock + seccomp-BPF（[Codex 官方文档](https://developers.openai.com/codex/sandbox/)）。
- **Anthropic sandbox-runtime（srt）**——Claude Code 沙箱实现，可整体借鉴：文件系统「读 = deny-then-allow、写 = allow-only（默认全禁写）」；强制保护路径（`.bashrc`、`.git/hooks/`、`.git/config` 等一律禁写）；网络全禁 + 本地代理放行 allowlist 域名；macOS 用动态生成的 Seatbelt profile、Linux 用 bubblewrap + seccomp、Windows 用独立 `srt-sandbox` 本地账户 + WFP 过滤 + NTFS ACL（[github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)，一手，已通读）。
- **Cloudflare Workers 安全模型**——「语言运行时隔离 + 能力 API」的极致样本：V8 isolate 同进程隔离（不能碰进程外内存）→ 进程层二重沙箱（namespace + seccomp，空文件系统、禁全部文件系统 syscall、禁网络，只留 Unix socket 与 supervisor 通信）→ 能力化 API（**不提供文件 API 所以没有文件访问**；出网走本地代理）。为防 Spectre 还把 `Date.now()` 钉死、禁多线程、可疑 Worker 动态迁到独立进程（[Cloudflare Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)、[How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)，一手，已通读）。它对 coding agent 的启示不是 V8，而是「**没有能力 = 没有风险**」与「默认全禁、按需放行」。

### 4.3 本地 coding agent 的取舍结论

- 要跑任意 shell + 零启动开销 + 进程树级覆盖 → **OS 原生沙箱（Seatbelt/Landlock+bwrap）是甜点位**：被 Codex 与 Claude Code 同时选中的架构，值得作为 spec 的「可选加固层」参照。
- Windows 主环境（本项目所在）没有等价的「无特权进程级文件沙箱」——最接近的是 srt-win 的「独立受限账户 + ACL/WFP」方案（需一次性提权安装）或 WSL2 里跑 Linux 沙箱；对教学项目属于过度工程，**笼子强度维持 worktree + 审批门**，OS 沙箱只记为 future work。
- 容器/VM 适合云端托管 agent（Codex cloud、OpenHands、E2B），不适合本地单用户 mini agent。

## 对本项目的设计启示

以下建议直接进入 spec-v3「自进化笼子」的设计输入（结合 `src/engine/approval/rules.ts`、`src/engine/tools/workspace.ts` 现状）：

1. **WorktreeManager（新模块，engine 层）**
   - 创建：`git worktree add <repo>/worktrees/<slug> -b cage-<slug> <baseRef>`；baseRef 默认 `origin/HEAD`（fresh），可配 `head`。
   - 注册表：用 `git worktree list --porcelain` 解析，不另存状态文件；`prune` 兜底。
   - 回收：退出时 **keep / remove 二选一，remove 前查 `git status --porcelain`，有未提交改动必须显式 `discard` 才允许删**（照抄 qwen-code 的语义，规避 claude-code #46470 的数据丢失）。
   - 守卫：并发 worktree 上限（如 3）；对笼内 git 写操作做轻量串行化（锁竞争证据：claude-code #55724）。
   - 收割：超龄（如 24h）worktree 自动拆除 + 分支归档，参照 AIDO NOW 的 TTL reaper。

2. **审批规则引擎升级（`rules.ts`，改动面小）**
   - 「区」从主仓库根切到**当前 worktree 根**：写工具 path 判定改为「realpath 解析后落在 worktree 根下 → allow/confirm；区外 → confirm（出区必批）；命中保护段 → deny」。
   - 保护段升级：`.git` 之外加 `.worktrees`（笼子自管目录）与 worktree 场景特有的 `.git` 指针文件解析（`gitdir:` 指向主仓库 `$GIT_DIR`，必须 realpath 后判 `.git` 保护，防止「词法上在区内、物理上写主仓库 `.git`」）。
   - `isInsideWorkspace` 补边界：symlink realpath、Windows 大小写不敏感与 junction；`resolveInside` 保持 throw-on-escape 语义。

3. **bash 工具（`run_command`）策略**
   - 保留 `SAFE_COMMAND_PATTERNS`/`DANGEROUS_COMMAND_PATTERNS`，但**只当免确认 UX，不当安全边界**；把 `python3 -c`、`node -e`、`perl -e`、`VAR=…; cmd` 前缀、`cp`/`mv` 等「间接写」形态加进确认/拒绝提示面。
   - 真实边界在 OS 层属于 future work：Linux/macOS 可接 bwrap/landlock/seatbelt（参照 Codex 与 Anthropic srt），Windows 记录 srt-win 式「受限账户 + ACL」路线；spec 里只写接口（`SandboxProvider`），不强制实现。

4. **威胁模型边界（写进 spec，防止过度设计）**
   - worktree + 审批门挡的是「事故/失控改动」，**不挡恶意 prompt injection**（AgentDojo 证实 prompt injection 可让 agent 主动做坏事：见 [arXiv:2406.13352](https://arxiv.org/abs/2406.13352)）；而笼子的「自进化」场景威胁模型是「agent 改坏自己的代码库」——worktree 的可整体回滚 + 出区必批恰好对症，这是强度定在 worktree + 审批门的学理依据。
   - 引用 YoloFS 的研究结论（290 起事故）作为「为什么默认全禁、改动先 staging、人可整体回滚」的论文级依据。

## 主要来源清单

- [git-worktree(1) 官方文档](https://git-scm.com/docs/git-worktree)
- [OpenAI Codex Sandboxing 官方文档](https://developers.openai.com/codex/sandbox/)（一手）
- [Anthropic Sandbox Runtime（srt）README](https://github.com/anthropic-experimental/sandbox-runtime)（一手）
- [Cloudflare Workers security model](https://developers.cloudflare.com/workers/reference/security-model/) / [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)（一手）
- [claude-code #55579：Bash sandbox bypassed by subagents via command obfuscation](https://github.com/anthropics/claude-code/issues/55579)
- [claude-code #55724：worktree 并发锁竞争](https://github.com/anthropics/claude-code/issues/55724) / [claude-code #46470：worktree 静默丢数据](https://github.com/anthropics/claude-code/issues/46470)
- [qwen-code #4056：EnterWorktree/ExitWorktree 规划](https://github.com/QwenLM/qwen-code/issues/4056)
- [lite-sandbox：静态分析沙箱及其局限](https://github.com/gartnera/lite-sandbox)
- [YoloFS：Don't Let AI Agents YOLO Your Files（arXiv:2604.13536）](https://arxiv.org/abs/2604.13536)
- [AgentDojo（arXiv:2406.13352）](https://arxiv.org/abs/2406.13352)
- [Claude Code Permission Rules 指南](https://arte.itlibra.com/en/articles/claude-code-permission-rules-settings) / [Codex Sandbox Internals（Daniel Vaughan）](https://codex.danielvaughan.com/2026/05/03/codex-cli-sandbox-internals-seatbelt-bubblewrap-landlock-windows-dacl/)
- [AIDO NOW：80 并发 agent 的 worktree 治理](https://www.aidonow.com/articles/ai/git-worktree-isolation-concurrent-agents)
- [Landlock LSM 详解](https://www.pandastack.ai/blog/landlock-lsm-explained/) / [NVIDIA NeMo Gym Docker 沙箱文档](https://docs.nvidia.com/nemo/gym/infrastructure/sandbox/docker) / [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
