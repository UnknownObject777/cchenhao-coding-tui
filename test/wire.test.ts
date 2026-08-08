import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/engine/events.js";
import { Rebuilder, WireService } from "../src/engine/wire.js";

const turn1: EngineEvent[] = [
  { type: "turn.started", turnId: 1, prompt: "hello" },
  { type: "assistant.delta", text: "Hi " },
  { type: "assistant.delta", text: "there" },
  { type: "tool.call", id: "c1", name: "read_file", args: { path: "a.txt" } },
  { type: "tool.result", id: "c1", name: "read_file", ok: true, output: "contents" },
  { type: "assistant.delta", text: "!" },
  { type: "turn.ended", turnId: 1, reason: "finish" },
];

describe("wire", () => {
  let dir: string;
  let wirePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-test-"));
    wirePath = join(dir, "wire.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends events and reads them back with contiguous seq", async () => {
    const wire = new WireService(wirePath);
    for (const event of turn1) await wire.append(event);

    const rows = await wire.readAll();

    expect(rows.map((r) => r.event)).toEqual(turn1);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("continues seq when appending to an existing log", async () => {
    const first = new WireService(wirePath);
    await first.append(turn1[0]!);

    const second = new WireService(wirePath);
    await second.append(turn1[5]!);

    const rows = await new WireService(wirePath).readAll();
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]!.event).toEqual(turn1[5]);
  });

  it("reads an empty log as no events", async () => {
    expect(await new WireService(wirePath).readAll()).toEqual([]);
  });

  it("rebuilds the message list from the event sequence", async () => {
    const wire = new WireService(wirePath);
    for (const event of turn1) await wire.append(event);

    const messages = new Rebuilder().rebuild(await wire.readAll());

    expect(messages).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hi there" },
      { role: "tool", name: "read_file", args: { path: "a.txt" }, ok: true, output: "contents" },
      { role: "assistant", text: "!" },
    ]);
  });
});
