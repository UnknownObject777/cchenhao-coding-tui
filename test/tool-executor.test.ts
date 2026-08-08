import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/engine/tools/executor.js";

describe("toolExecutor", () => {
  it("executes a registered tool and passes args through", async () => {
    const executor = new ToolExecutor();
    executor.register({
      name: "echo",
      description: "echo back the input",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: (args) => `got:${String(args["text"])}`,
    });

    const result = await executor.execute("echo", { text: "hi" });

    expect(result).toEqual({ ok: true, output: "got:hi" });
  });

  it("returns an error result for an unregistered tool", async () => {
    const executor = new ToolExecutor();

    const result = await executor.execute("nope", {});

    expect(result.ok).toBe(false);
    expect(result.output).toContain("nope");
  });

  it("turns a throwing tool into an error result instead of crashing", async () => {
    const executor = new ToolExecutor();
    executor.register({
      name: "boom",
      description: "always throws",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("kaboom");
      },
    });

    const result = await executor.execute("boom", {});

    expect(result).toEqual({ ok: false, output: expect.stringContaining("kaboom") });
  });

  it("lists tool definitions for the LLM request", () => {
    const executor = new ToolExecutor();
    executor.register({
      name: "echo",
      description: "echo back the input",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: () => "",
    });

    expect(executor.definitions()).toEqual([
      {
        name: "echo",
        description: "echo back the input",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);
  });
});
