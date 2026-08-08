#!/usr/bin/env node
import { bootstrap } from "../bootstrap.js";
import { runPrompt } from "./run-prompt.js";

const USAGE = `mini coding agent

用法:
  agent -p "<prompt>"   一次性执行（print 模式），结果输出到 stdout
  agent                 交互式 TUI（尚未实现，见 issue #1 后续 milestone）

环境变量:
  KIMI_API_KEY   直接用 API key（不设置则读 kimi-code 订阅的 OAuth 凭证）
  KIMI_BASE_URL  覆盖 base URL（默认 https://api.kimi.com/coding/v1）
  KIMI_MODEL     覆盖模型（默认 kimi-for-coding）
  FAKE_LLM=1     用预置脚本演示，无需任何凭证
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const promptFlag = args.findIndex((a) => a === "-p" || a === "--prompt");
  const prompt = promptFlag >= 0 ? args[promptFlag + 1] : undefined;

  if (prompt === undefined) {
    process.stderr.write("交互式 TUI 尚未实现（后续 milestone）。MVP 请用：agent -p \"<prompt>\"\n");
    process.exit(2);
  }

  const agent = await bootstrap({
    workspace: process.cwd(),
    fake: process.env["FAKE_LLM"] === "1",
  });
  process.exit(await runPrompt(agent, prompt));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
