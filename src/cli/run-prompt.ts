import type { Agent } from "../bootstrap.ts";

/**
 * print 模式驱动（类比 kimi-code 的 run-prompt.ts）：
 * 订阅引擎事件——assistant 文本写 stdout，工具帧写 stderr，turn 结束定退出码。
 */
export async function runPrompt(agent: Agent, prompt: string): Promise<number> {
  const { bus, loop } = agent;

  bus.on("assistant.delta", ({ text }) => process.stdout.write(text));
  bus.on("tool.call", ({ name, args }) => {
    process.stderr.write(`\n[tool.call] ${name} ${JSON.stringify(args)}\n`);
  });
  bus.on("tool.result", ({ name, ok, output }) => {
    const summary = output.length > 200 ? output.slice(0, 200) + "…" : output;
    process.stderr.write(`[tool.result] ${name} ${ok ? "ok" : "FAILED"}: ${summary}\n`);
  });

  const ended = new Promise<"finish" | "error">((resolve) => {
    bus.on("turn.ended", ({ reason, error }) => {
      if (reason === "error") process.stderr.write(`\n[turn error] ${error ?? "unknown"}\n`);
      resolve(reason);
    });
  });

  await loop.runTurn(prompt);
  const reason = await ended;
  process.stdout.write("\n");
  return reason === "finish" ? 0 : 1;
}
