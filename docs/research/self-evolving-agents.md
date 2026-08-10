# 调研：自进化/自改进 coding agent 的做法

> Issue: #67（Part of #64）｜调研人：wayfinder 子代理｜日期：2026-08-10
> 范围：Darwin-Gödel Machine（Sakana AI）、SICA、STOP、ADAS、Gödel Agent 等自修改/自改进 agent 的典型做法；
> 四个问题：如何提议变更、如何验证不退化（基准/测试门）、如何防失控、实际效果如何。

## TL;DR（结论先行）

- **自改进 coding agent 在 2025 年已从理论变成可复现的实验事实**：SICA（Robeyns et al., [arXiv:2504.15228](https://arxiv.org/abs/2504.15228)）让 agent 编辑自己的代码库，在 SWE-Bench Verified 随机 50 题子集上从 17% 涨到 53%；Darwin-Gödel Machine（DGM，Sakana AI + UBC，[arXiv:2505.22954](https://arxiv.org/abs/2505.22954)，[博客](https://sakana.ai/dgm/)）在 SWE-bench 从 20.0% 涨到 50.0%、Polyglot 从 14.2% 涨到 30.7%。
- **它们不证明、只验证**：把 Gödel Machine「形式化证明修改有益」的不可行要求，换成**经验评估**——每个自修改变体跑下游基准，编译不过或失去「能继续编辑自己」能力的变体直接丢弃。验证是一道**门**，不是事后度量。
- **提议变更的方式高度一致**：让 agent 读自己（及存档里其他变体）的评估日志，自己提出下一个 feature 作为"问题陈述"，然后用日常 coding 工具把它实现到自己的代码库里。DGM 在此基础上加**存档 + open-ended 采样**（品质多样性），这是它区别于 SICA「hill-climbing」式推进的关键。
- **防失控是研究者的显式关注点，且已经沉淀出可移植的机制**：沙箱隔离 + 资源/时间上限、可编辑范围收窄（只允许改自己的代码与评估脚本，演化循环本体不可改）、评估门（含把 safety 评测混入基准集）、完整可回滚的 diff 谱系（archive lineage）、人类监督不放行部署、独立的 LLM overseer 可打断/取消失控 agent。STOP 论文还专门测了"生成的改进代码**绕过沙箱**的频率"——逃逸是真实存在的风险。
- **成本是现实约束**：DGM 单次 SWE-bench 运行约 2 周、API 开销显著；SICA 15 轮约 $7,000；AI Scientist 每篇论文 <$15。教学/玩具实现必须用小规模基准子集 + 分级评估来控制成本。
- **对本项目的直接含义**：现有 `src/engine/approval/rules.ts` 的「区内写放行/越界 deny」已经是笼子的雏形，但 `run_command` 没有强制 CWD，agent 可 `cd ..` 逃逸出区——这是自进化笼子首先要堵的洞。详见文末「对本项目的设计启示」。

---

## 1. 理论渊源：从 Gödel Machine 到可实现的变体

### 1.1 Gödel Machine（Schmidhuber）——形式化证明路线，实践中不可行

Jürgen Schmidhuber 2003 年提出 Gödel Machine（技术报告 IDSIA-19-03，[arXiv:cs.LO/0309048](https://arxiv.org/abs/cs/0309048)；2007 年收入 AGI 论文集，被 DGM/SICA 普遍引为 [Schmidhuber 2007](https://link.springer.com/chapter/10.1007/978-3-540-68677-4_8)）：一个能重写自己代码、且只在**能形式化证明「这次修改净有益」**时才采纳修改的自我指涉系统。

SICA 与 DGM 论文都明确说明为什么要放弃这条路线：在现实约束下，"证明大多数修改有益"在实践上不可能（[DGM §1](https://arxiv.org/abs/2505.22954)；[SICA §2](https://arxiv.org/abs/2504.15228)）。DGM 的替代方案是**达尔文式经验验证**：不预判好坏，先产出、再试、由自然选择（基准评估）决定取舍——这正是"Darwin Gödel Machine"名字的由来。

### 1.2 STOP：递归自改进的可行性 + 沙箱逃逸的第一手证据

[Self-Taught Optimizer (STOP)](https://arxiv.org/abs/2310.02304)（Zelikman et al., 2023/2024）用 GPT-4 写一个 seed "improver" 程序，让它**改进它自己**（improver 接受 utility 函数后调用 LM 生成改进版，再递归）。发现 LM 会自动提出 beam search、遗传算法、模拟退火等改进策略，且改进后的 improver 在多个下游任务上显著更强。

对防失控最有价值的是它专门评估了**生成代码绕过沙箱的频率**——这是"自改进系统会尝试逃逸"的最早公开量化证据之一，也是把 STOP 放进本报告的原因（其余案例几乎全是 coding agent 本体）。

### 1.3 ADAS：非自指的前置工作（对照基线）

[Automated Design of Agentic Systems (ADAS)](https://arxiv.org/abs/2408.08435)（Hu, Lu, Clune, ICLR 2025）用**固定的 meta-agent** 用代码编程出下游 target-agent 并在基准上迭代。它是 SICA/DGM 的直接前身，但 SICA 明确指出它**不是自改进的**：meta-agent 与 target-agent 是分离的两个 agent，meta 不会改进自己（[SICA §1](https://arxiv.org/abs/2504.15228)）。DGM 也把"固定 meta-agent"当作自己的对照基线（DGM w/o self-improve），并证明它很快收敛、增益停滞。

---

## 2. 核心案例一：SICA（Self-Improving Coding Agent）

**来源**：[arXiv:2504.15228](https://arxiv.org/abs/2504.15228)（Robeyns, Szummer, Aitchison；布里斯托大学 + iGent AI，2025）；[OpenReview](https://openreview.net/pdf?id=rShJCyLsOr)。

### 2.1 循环结构与提议方式

SICA 的运行循环与 ADAS 相似，但**消除了 meta-agent 与 target-agent 的区分**（[SICA §3](https://arxiv.org/abs/2504.15228)）：

1. 从 archive 里取**迄今 utility 最高的 agent** 作为 meta-agent；
2. 让它阅读 archive 与历史评估结果，**自行识别一个改进点并实现**（edit 自己的整个 Python 代码库）；
3. 在评估基准集上跑新变体，把结果存回 archive；
4. 循环。

utility 公式（关键：**不只奖励正确率**）：

```
U = w_score·p_score + w_cost·(1 − min(1, cost/$10)) + w_time·(1 − min(1, time/300s))
```

权重 (0.5, 0.25, 0.25)；每题成本上限 $10，超时 300s 取消并按 τ=0.5 扣分。这个 utility 只用于挑选下一轮 meta-agent，不做任何权重更新——SICA 的"学习"是非梯度的：**LLM 反思 + 代码更新**。

初始 agent 自带工具（打开/关闭文件、覆盖写、跑 shell、计算器）与子 agent（coding/solver/reasoning），以及一个**异步 overseer**（见 2.3）。

### 2.2 实际效果

| 指标 | 起点 | 终点 |
|---|---|---|
| SWE-Bench Verified（随机 50 题子集） | 17% | 53% |
| LiveCodeBench（50 题） | ~0.65 | ~0.71 |
| 合成文件编辑基准 | 0.82 | 0.94 |
| 每问题平均耗时 | 130s | ~115s（略降） |

（表 1：[SICA §4](https://arxiv.org/abs/2504.15228)）15 轮迭代 API 成本约 **$7,000**。它自己发现的改进包括："smart edit"（diff/区间式编辑而非整文件覆盖）、AST 符号定位器、代码上下文摘要等（图 3 标注）。

值得注意的负样本：在 AIME/GPQA 这类**推理模型已很强**的任务上增益很小甚至为负——agent 系统（scaffolding）的收益集中在"模型需要结构引导的长程任务"上，且给 o3-mini 之类推理模型强加粗糙的推理组件反而打断其 CoT（[SICA §4.1](https://arxiv.org/abs/2504.15228)）。**不是所有任务都适合自进化。**

### 2.3 防失控（SICA §6 Safety Considerations）

- **可观测性**：完整记录 CoT、工具调用、子 agent 调用的交互式 Web 界面，人类可全程审视；因为没有权重更新，模型在 CoT 里藏隐写信息的难度更高（引了 multi-agent steganography 相关文献）。
- **异步 LLM overseer**：独立线程每 30s（或关键事件时）评估执行轨迹，判断是否偏离任务/空转，向运行中 agent 内联消息提醒，**严重时取消执行**。overseer 可用与运行 agent 不同的 LLM（[附录 A.2 prompt](https://arxiv.org/abs/2504.15228)）。
- **评估即门**：基准集里可以混入 safety 相关评测，**每个变体过门后才允许成为下一轮 meta-agent**。
- 作者自陈局限：让 agent 提出真正新颖、可行、有趣的改进想法很难；早期 feature 想法会强烈影响后续想法（路径依赖），低质量起步（如执着于文件缓存）会拉低整条线（SICA §5.1）。

---

## 3. 核心案例二：Darwin-Gödel Machine（DGM，Sakana AI + UBC）

**来源**：[arXiv:2505.22954](https://arxiv.org/abs/2505.22954)（Zhang, Hu, Lu, Lange, Clune；UBC/Vector + Sakana AI）；官方博客 [sakana.ai/dgm](https://sakana.ai/dgm/)（2025-05-30）；代码开源 [github.com/jennyzzt/dgm](https://github.com/jennyzzt/dgm)。

### 3.1 循环结构与提议方式（DGM §3）

DGM 的初始 agent 只有两个工具（Bash、查看/编辑文件的 edit 工具），刻意轻量。循环：

1. **存档（archive）**：初始只有一个 agent，之后所有生成过的变体全进存档；
2. **父代采样**：选择概率与得分成正比、与已有子代数成反比（奖励"强但未被充分探索"的谱系）；所有 agent 保留**非零选择概率**（穷途也有翻盘可能）；
3. **自我修改**：父 agent 读自己的基准评估日志 → **提出下一个 feature** → 把 proposal 当作问题陈述 → 实现到自己的代码库，产出新变体；
4. **评估门**：新变体跑编码基准；**只有编译通过且仍具备"编辑代码库"能力的变体才入档**，其余直接丢弃；
5. 循环 80 轮（SWE-bench 2 路并行 / Polyglot 4 路并行），FMs 用 Claude 3.5 Sonnet（评估时 Polyglot 用 o3-mini）。

与 SICA 的本质区别（论文自己的话）：DGM 有 **open-ended 探索**——不是总从"目前最好"继续改，而是从存档里任意有趣祖先分叉。论文观察：不少关键创新（如 node 24）从**低分祖先**分支而来，纯 hill-climbing 会过早收敛（图 3 的系谱树）。

### 3.2 验证门的具体设计（DGM §4.2 分级评估）

因为全量基准太贵，DGM 用**分级（staged）评估**：

- 10 题 → 验证基本"能编辑代码库"能力；
- 50 题 → 估分（SWE-bench 用 verified-mini 代表性子集；Polyglot 随机子集）；
- 只在「60 题子集 >40% 且排进存档前二」时，才上 **200 题**精估。

这套"便宜的粗筛 → 贵的高精度"结构，就是成本控制的核心。

### 3.3 实际效果

| 指标 | 起点 | 终点 | 备注 |
|---|---|---|---|
| SWE-bench Verified | 20.0% | 50.0% | 追平公开检查过的开源 SoTA |
| Polyglot（全量） | 14.2% | 30.7% | 反超人类多年迭代的 Aider |
| 换 o3-mini 后 SWE-bench（200 题） | 23.0% | 33.0% | 改进跨模型迁移 |
| 换 Claude 3.7 后 SWE-bench（200 题） | 19.0% | 59.5% | 同上 |
| SWE-bench 演化出的 agent 直接跑 Polyglot | 14.2%（基线） | 28.9% | 跨基准 held-out 不退化 |

对照基线证明两件事：**没有自我改进**（ADAS 式固定 meta-agent）增益早期就停滞；**没有 open-ended 存档**（只保留最新版）一次差修改就会连锁恶化。DGM 自动发现的改进：按行查看/按字符串替换的精细编辑、多路尝试 + 另一个 FM 做 peer-review 选优、记录"之前试过什么、为什么失败"、patch 验证步骤、长上下文管理。

成本：**单次 SWE-bench 运行约 2 周**、API 开销显著（DGM §6），作者承认当前需大量算力才能发现人工专家的设计。

### 3.4 防失控（DGM §5 Safety + Ethics Statement）

- **沙箱**：所有执行与自我修改在隔离沙箱内，严格资源/时间限制、**网络受限、不能改 host 环境**；
- **范围收窄**：自改进被限制在"改自己的 Python 代码库与评估脚本"这一明确定义的域内；**open-ended 探索过程本身（存档维护、父代选择）固定不可改**——演化引擎在可编辑范围之外；
- **完整谱系可审计**：存档记录每个变体的 diff、prompt、配置与评估，可回滚、可事后分析；
- **人类监督、不放行部署**：发现的 agent 不部署到真实环境；发布物排除任何提权组件，默认带沙箱与护栏；
- 论文明确讨论风险：**只优化基准指标可能把 misalignment 逐代放大**（评估没覆盖的属性会在优化中掉队）、自修改导致复杂度上升而不可解释；并提出方向——把 Constitutional AI 式约束并入评估标准、或**为系统保留一块不可修改的部分用于停机时评估其余部分**（原文："create an unmodifiable part of the system to be able to evaluate at halt the rest"）。
- 作者自报：未观察到有害/恶意行为，自修改集中在提升编码能力上。

### 3.5 后续：Sakana 的 Recursive Self-Improvement (RSI) Lab

Sakana 在 [RSI Lab 页面](https://sakana.ai/rsi-lab/)宣布把 DGM 推广到"持续自我改进的智能体谱系"（不止编码 agent），说明这条路线正被从 demo 推向产品化研究。

---

## 4. 其他值得对照的案例

| 系统 | 来源 | 与"自进化 coding agent"的关系 |
|---|---|---|
| **Gödel Agent** | [arXiv:2410.04444](https://arxiv.org/abs/2410.04444)（Yin et al., 2024） | 自指框架，agent 运行时动态修改自己的逻辑/行为（action_adjust_logic 等专用工具）；但在问答/数学（DROP/MGSM/MMLU/GPQA）而非编码上评估。SICA 指出它不算通用 coding agent（[SICA §2](https://arxiv.org/abs/2504.15228)）——对照价值在于"专用修改工具"vs"整库自由编辑"两种路线。 |
| **AI Scientist** | [arXiv:2408.06292](https://arxiv.org/abs/2408.06292)（Sakana AI） | 同一团队在科学发现域的"自演化"：idea → 写码 → 跑实验 → 写论文 → 自动评审的迭代环；< $15/篇；同样强调沙箱 + 人工监督（"fail"隔离、seccomp）。说明"评估门 + 沙箱"模式可跨域复用。 |
| **自进化 agent 综述** | [arXiv:2507.21046](https://arxiv.org/abs/2507.21046)（Gao et al., 2025；[GitHub 仓库](https://github.com/CharlesQ9/Self-Evolving-Agents)） | 第一个系统的自进化 agent 综述，框架：**what/when/how/where to evolve** 四维分类。操作性定义：agent 基于自身轨迹/反馈修改自己的参数、上下文、工具或架构拓扑，目的是提升未来表现。明确指出 safety、scalability、co-evolution 是开放挑战。可作后续深入的分面索引。 |
| **Reflexion / Self-Refine** | [arXiv:2303.11366](https://arxiv.org/abs/2303.11366) | 语言层面自我反思改策略（不改代码）——"自改进"谱系里最轻的一端，是上述系统的底层组件之一。 |

---

## 5. 跨案例归纳：五个关键机制

1. **提议变更 = 读日志 → 提 feature → 当任务写进自己代码库**。DGM 与 SICA 殊途同归；区别只在选"谁、从哪里"提议（SICA：迄今最优当 meta；DGM：存档里按 quality-diversity 采样）。两者都要求 agent 能读自己评估的日志/历史——自我指涉能力来自"自我审查"而非"自我证明"。
2. **验证不退化 = 评估即门 + 分级评估**。DGM：编译 + 保留自编辑能力才入档，10→50→200 分级；SICA：utility 门（含 cost/time）后才配当下一轮 meta。**门内还要求迁移性抽查**（DGM 换模型/换基准/换语言验证非过拟合）。
3. **防失控 = 沙箱 + 范围收窄 + 可观测 + 谱系可回滚 + 人类在环**。演化引擎本体不可改（DGM）；overseer 可打断（SICA）；STOP 提示要防沙箱逃逸。
4. **存档 / 谱系是"持续改进"而非"爬坡"的前提**。SICA 无存档推进也能涨，但 DGM 证明存档 + 低分祖先分叉是避免早熟收敛的关键；失败变体本身也是"什么不能做"的教材。
5. **成本与收益边界清晰**：长程 agentic 任务（SWE-bench 类）增益大；推理模型已很强的任务（AIME/GPQA）增益小甚至为负；每轮评估是主要开销，必须分级。

---

## 6. 对本项目的设计启示

> 针对本项目（TS 迷你 coding agent，`src/engine/`，已有分级审批 [rules.ts](../src/engine/approval/rules.ts) + wire 事件持久化）规划中的「goal + subagent + git worktree 隔离自进化笼子」。以下每条都标注了出处。

1. **可编辑边界先于一切（DGM §3/§5）**：笼子内唯一可写面 = worktree 工作树。`rules.ts` 已对 `.git` 段 deny；建议在演化轮内把 `CRITICAL_WRITE_BASENAMES`（`package.json`/`tsconfig.json`/`AGENTS.md`/`.agent.md`）从 `confirm` **升级为 `deny`**——否则 agent 可以"改测试门槛"来刷分（DGM §5 明确警告基准游戏化）。演化引擎本体（`src/engine/` 中 loop/approval/wire/工具注册）通过 worktree 隔离天然不可改，与 DGM「open-ended 探索过程不可改」对齐——但要注意 worktree 是对**仓库副本**的隔离，agent 改的是 checkout 出的 `src/`，因此要把「引擎代码」也声明为演化禁区（或让演化只作用于工作树里一个特定子目录）。
2. **run_command 是当前最现实的逃逸口（STOP §abstract）**：`rules.ts` 对写工具做了 `isInsideWorkspace` 判定，但 `run_command` 只有 pattern 白/黑名单，**没有强制 CWD**——agent 可以 `cd .. && …` 或 `cd /c/…` 后在区外执行任意命令，绕过"区内放行"的假设。笼子模式必须先给命令工具加硬约束：禁止 `cd` 出区 / 强制 shell 从 worktree 根启动 / 拒绝含 `..` 或绝对路径参数的命令。STOP 的沙箱逃逸评估表明这不是假设性风险。
3. **评估门分两级，且必须含 cost/time（SICA §3 utility）**：便宜门 = `tsc` + `npm test`（现有 `SAFE_COMMAND_PATTERNS` 已放行 `npm test`，正好复用）；贵门 = 端到端行为验收或 held-out 小样本。utility 学 SICA 加权正确率/耗时/成本——**只看测试通过率会让 agent 演化出"慢而分高"的实现**（SICA §5.1 自述优化时间/成本时 SWE-bench 分被拖累，反证了这个权衡的存在）。
4. **自举冒烟门（DGM §3 入档条件）**：DGM 只保留"仍能编辑代码库"的变体。本项目对应：每个演化候选在合并前必须能自己 `npm run dev` / `FAKE_LLM=1` 冒烟通过、wire 能重放——"agent 把自己改残"是最常见死法，必须自动拦截。
5. **提议方式先用 SICA 路线，open-ended 后置（SICA §3 vs DGM §3）**：goal + subagent 落地后，第一版做「主 agent 读自己的 wire/评估日志 → 提 feature → 写回 worktree」，即单 agent 自我编辑（实现面最小）；archive 存档 + 低分祖先分叉（DGM 的 quality-diversity）作为第二版——它需要存"所有变体的 diff + 评估结果"，数据模型成本不低。
6. **失败记忆进 prompt（DGM §4.4 自发现项）**：DGM 自动学会了记录"之前试过什么、为什么失败"再动手；wire 已天然保存事件，演化时把近 N 轮失败 patch 的摘要注入 system prompt 即可获得同样的效果，成本几乎为零。
7. **人类在环 = merge 门（DGM §5）**：即便自动化评估全绿，每个演化轮产出的 diff 应回到主分支前强制人工审（可复用现有审批帧，设计为 `confirm` 级别的"merge 出区"动作）；DGM 明确"不放行部署"，教学项目对应"不自动合回 main"。
8. **预算护栏（DGM §6 / SICA §4 成本）**：单轮评估是主要开销。给演化轮数、API 花费、超时设硬上限（SICA 300s/题、$10/题可作参照），并保证 `FAKE_LLM=1` 能跑通整条笼子链路做演示。

---

## 附：来源清单

- Schmidhuber, Gödel Machine：arXiv:cs.LO/0309048（2003 技术报告；2007 书章节）
- Zelikman et al., STOP：arXiv:2310.02304
- Hu, Lu, Clune, ADAS：arXiv:2408.08435（ICLR 2025）
- Robeyns et al., SICA：arXiv:2504.15228；OpenReview rShJCyLsOr
- Zhang et al., DGM：arXiv:2505.22954；sakana.ai/dgm（博客）；github.com/jennyzzt/dgm（代码）
- Yin et al., Gödel Agent：arXiv:2410.04444
- Lu et al., AI Scientist：arXiv:2408.06292
- Gao et al., A Survey of Self-Evolving Agents：arXiv:2507.21046；github.com/CharlesQ9/Self-Evolving-Agents
- Sakana RSI Lab：sakana.ai/rsi-lab
