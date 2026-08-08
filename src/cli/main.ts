#!/usr/bin/env node
import pkg from "../../package.json" with { type: "json" };
import { bootstrap } from "../bootstrap.ts";
import { errorMessage } from "../engine/tools/executor.ts";
import { runTui } from "../tui/app.ts";
import { runPrompt } from "./run-prompt.ts";

const USAGE = `mini coding agent

用法:
  mini-agent -p "<prompt>"   一次性执行（print 模式），结果输出到 stdout
  mini-agent -p --yes|-y "..."  放行写/执行类工具调用（危险 pattern 仍被规则引擎拒绝）
  mini-agent                 交互式 TUI（默认继续该目录的最近会话）
  mini-agent --new           交互式 TUI，强制新会话

环境变量:
  KIMI_API_KEY   直接用 API key（不设置则读 kimi-code 订阅的 OAuth 凭证）
  KIMI_BASE_URL  覆盖 base URL（默认 https://api.kimi.com/coding/v1）
  KIMI_MODEL     覆盖模型（默认 kimi-for-coding）
  FAKE_LLM=1     用预置脚本演示，无需任何凭证
`;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  // 先挑出带值/不带值的已知旗标，余下位置参数再取 -p 的值
  const yes = rawArgs.includes("--yes") || rawArgs.includes("-y");
  const newSession = rawArgs.includes("--new");
  let outputFormat: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = rawArgs[i]!;
    if (a === "--yes" || a === "-y" || a === "--new") continue;
    if (a === "--output-format") {
      outputFormat = rawArgs[i + 1];
      i += 1;
      continue;
    }
    args.push(a);
  }
  if (outputFormat !== undefined && outputFormat !== "text" && outputFormat !== "stream-json") {
    process.stderr.write(`未知 --output-format: ${outputFormat}（可选 text | stream-json）\n`);
    process.exit(2);
  }

  const promptFlag = args.findIndex((a) => a === "-p" || a === "--prompt");
  const prompt = promptFlag >= 0 ? args[promptFlag + 1] : undefined;

  const agent = await bootstrap({
    workspace: process.cwd(),
    fake: process.env["FAKE_LLM"] === "1",
    // print 模式无人可问：装配 --yes 审批策略（#27）；TUI 模式的交互审批归 #28
    ...(prompt !== undefined ? { printApproval: { yes } } : {}),
    ...(prompt === undefined && !newSession ? { session: "continue" as const } : {}),
  });

  if (prompt !== undefined) {
    process.exit(await runPrompt(agent, prompt, { ...(outputFormat !== undefined ? { outputFormat } : {}) }));
  }

  await runTui(agent, {
    toolName: "mini-agent",
    version: pkg.version,
    model: agent.model,
    cwd: process.cwd(),
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
