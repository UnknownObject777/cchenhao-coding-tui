import type { Agent } from "../bootstrap.ts";
import { ENGINE_EVENT_NAMES } from "../engine/events.ts";

export type OutputFormat = "text" | "stream-json";
export const OUTPUT_FORMATS: OutputFormat[] = ["text", "stream-json"];

export interface RunPromptOptions {
  /** text（默认）= 人类可读；stream-json = 引擎事件逐行 JSON（#46，供脚本管道消费）。 */
  outputFormat?: OutputFormat;
  /** 测试缝：替换 stdout/stderr 写入。 */
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/**
 * print 模式驱动（类比 kimi-code 的 run-prompt.ts）：
 * text 模式——assistant 文本写 stdout，工具帧写 stderr；
 * stream-json 模式——全部引擎事件逐行 JSON 写 stdout，turn 结束定退出码。
 * 事件订阅在返回前全部退订（与 streaming-ui/coordinator 同一纪律，重复驱动同一 Agent 不叠加）。
 */
export async function runPrompt(agent: Agent, prompt: string, options: RunPromptOptions = {}): Promise<number> {
  const { bus, loop } = agent;
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  const unsubscribes: Array<() => void> = [];

  try {
    if (options.outputFormat === "stream-json") {
      for (const name of ENGINE_EVENT_NAMES) {
        unsubscribes.push(
          bus.on(name, (payload: unknown) => {
            out(JSON.stringify({ type: name, ...(payload as Record<string, unknown>) }) + "\n");
          }),
        );
      }
    } else {
      unsubscribes.push(
        bus.on("assistant.delta", ({ text }) => out(text)),
        bus.on("tool.call", ({ name, args }) => {
          err(`\n[tool.call] ${name} ${JSON.stringify(args)}\n`);
        }),
        bus.on("tool.result", ({ name, ok, output }) => {
          const summary = output.length > 200 ? output.slice(0, 200) + "…" : output;
          err(`[tool.result] ${name} ${ok ? "ok" : "FAILED"}: ${summary}\n`);
        }),
      );
    }

    const ended = new Promise<"finish" | "error">((resolve) => {
      unsubscribes.push(
        bus.on("turn.ended", ({ reason, error }) => {
          if (options.outputFormat !== "stream-json" && reason === "error") err(`\n[turn error] ${error ?? "unknown"}\n`);
          resolve(reason);
        }),
      );
    });

    await loop.runTurn(prompt);
    const reason = await ended;
    if (options.outputFormat !== "stream-json") out("\n");
    return reason === "finish" ? 0 : 1;
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
  }
}
