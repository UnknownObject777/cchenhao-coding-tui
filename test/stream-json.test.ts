import { describe, expect, it } from "vitest";

import { runPrompt } from "../src/cli/run-prompt.ts";
import type { Agent } from "../src/bootstrap.ts";
import { EventBus } from "../src/engine/events.ts";
import { FakeLLM } from "../src/engine/llm/fake.ts";
import { Loop } from "../src/engine/loop.ts";
import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { WireService } from "../src/engine/wire.ts";

function fakeAgent(script: ConstructorParameters<typeof FakeLLM>[0]): Agent {
  const bus = new EventBus();
  const llm = new FakeLLM(script);
  const executor = new ToolExecutor();
  executor.register({
    name: "noop",
    description: "d",
    parameters: {},
    execute: () => "done",
  });
  return {
    loop: new Loop({ llm, executor, bus, systemPrompt: "" }),
    bus,
    wire: new WireService(":memory:"),
    workspace: ":memory:",
    model: "fake-llm",
    sessionPath: ":memory:",
    history: [],
    approvalMemory: [],
    systemPrompt: "",
  };
}

describe("runPrompt --output-format stream-json (#46)", () => {
  it("emits every engine event as one JSON line on stdout", async () => {
    const agent = fakeAgent([
      [{ type: "text", text: "你好" }, { type: "finish", reason: "stop" }],
    ]);
    let stdout = "";
    let stderr = "";

    const code = await runPrompt(agent, "hi", {
      outputFormat: "stream-json",
      out: (t) => (stdout += t),
      err: (t) => (stderr += t),
    });

    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as { type: string });
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "context.usage",
      "assistant.delta",
      "context.usage",
      "turn.ended",
    ]);
    expect(events[2]).toMatchObject({ type: "assistant.delta", text: "你好" });
    expect(stderr).toBe(""); // 结构化模式不写 stderr 帧
  });

  it("text mode stays the default human-readable shape", async () => {
    const agent = fakeAgent([
      [{ type: "text", text: "hello" }, { type: "finish", reason: "stop" }],
    ]);
    let stdout = "";

    const code = await runPrompt(agent, "hi", { out: (t) => (stdout += t) });

    expect(code).toBe(0);
    expect(stdout).toBe("hello\n");
  });
});
