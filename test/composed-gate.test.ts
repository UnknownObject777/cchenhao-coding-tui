import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/engine/events.ts";
import { createComposedGate, memoryKey } from "../src/engine/approval/composed-gate.ts";
import type { EngineEvent } from "../src/engine/events.ts";

const WS = "D:/proj";

function setup(answer: "allow" | "always" | "deny" = "allow") {
  const bus = new EventBus();
  const events: EngineEvent[] = [];
  bus.on("approval.request", (p) => events.push({ type: "approval.request", ...p }));
  const ask = vi.fn<(call: unknown) => Promise<"allow" | "always" | "deny">>().mockResolvedValue(answer);
  const gate = createComposedGate({ bus, workspace: WS, answerer: { ask } });
  return { bus, events, ask, gate };
}

describe("composed approval gate", () => {
  it("auto-allows read-only calls without asking", async () => {
    const { gate, ask, events } = setup();
    const decision = await gate.request({ id: "1", name: "read_file", args: { path: "a.ts" } });
    expect(decision).toBe("allow");
    expect(ask).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("auto-denies dangerous calls without asking, but leaves a deny request record", async () => {
    const { gate, ask, events } = setup("allow");
    const decision = await gate.request({ id: "1", name: "run_command", args: { command: "rm -rf /" } });
    expect(decision).toBe("deny");
    expect(ask).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "approval.request", id: "1", name: "run_command", args: { command: "rm -rf /" }, level: "deny" },
    ]);
  });

  it("asks the answerer for confirm-level calls and publishes a confirm request", async () => {
    const { gate, ask, events } = setup("allow");
    const decision = await gate.request({ id: "1", name: "write_file", args: { path: "a.ts" } });
    expect(decision).toBe("allow");
    expect(ask).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: "approval.request", id: "1", name: "write_file", args: { path: "a.ts" }, level: "confirm" },
    ]);
  });

  it("remembers 'always' for the same pattern within the session (#26)", async () => {
    const { gate, ask, events } = setup("always");
    const call = { id: "1", name: "run_command", args: { command: "npm install" } };
    expect(await gate.request(call)).toBe("always");
    expect(ask).toHaveBeenCalledTimes(1);

    // 同 pattern（npm 前缀两段）再问不再弹
    const again = { id: "2", name: "run_command", args: { command: "npm install lodash" } };
    expect(await gate.request(again)).toBe("allow");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "approval.request")).toHaveLength(1);
  });

  it("does not remember plain 'allow' — asks again next time", async () => {
    const { gate, ask } = setup("allow");
    await gate.request({ id: "1", name: "run_command", args: { command: "npm install" } });
    await gate.request({ id: "2", name: "run_command", args: { command: "npm install" } });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("different command heads are different memories", async () => {
    const { gate, ask } = setup("always");
    await gate.request({ id: "1", name: "run_command", args: { command: "npm install" } });
    await gate.request({ id: "2", name: "run_command", args: { command: "node build.js" } });
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe("memoryKey", () => {
  it("is tool name + first two words of the first string arg", () => {
    expect(memoryKey({ id: "1", name: "run_command", args: { command: "npm install lodash" } })).toBe(
      "run_command:npm install",
    );
    expect(memoryKey({ id: "1", name: "write_file", args: { path: "src/a.ts" } })).toBe("write_file:src/a.ts");
  });

  it("falls back to bare tool name without string args", () => {
    expect(memoryKey({ id: "1", name: "noop", args: {} })).toBe("noop");
  });
});
