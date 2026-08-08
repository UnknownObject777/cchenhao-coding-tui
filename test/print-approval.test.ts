import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { createPrintAnswerer } from "../src/engine/approval/print-answerer.ts";

describe("createPrintAnswerer", () => {
  it("allows with --yes", async () => {
    const answerer = createPrintAnswerer(true);
    expect(await answerer.ask({ id: "1", name: "write_file", args: { path: "a" } })).toBe("allow");
  });

  it("denies without --yes and explains why", async () => {
    const onDeny = vi.fn();
    const answerer = createPrintAnswerer(false, onDeny);
    const decision = await answerer.ask({ id: "1", name: "write_file", args: { path: "a" } });
    expect(decision).toBe("deny");
    expect(onDeny).toHaveBeenCalledOnce();
    expect(String(onDeny.mock.calls[0]![0])).toContain("--yes");
  });
});

describe("print-mode approval through bootstrap (#27)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "print-approval-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("without --yes the fake demo's write_file is denied and nothing lands on disk", async () => {
    const agent = await bootstrap({ workspace: dir, fake: true, printApproval: { yes: false } });
    await agent.loop.runTurn("demo");

    expect(existsSync(join(dir, "hello.txt"))).toBe(false);
  });

  it("with --yes the demo turn completes end to end", async () => {
    const agent = await bootstrap({ workspace: dir, fake: true, printApproval: { yes: true } });
    await agent.loop.runTurn("demo");

    expect(existsSync(join(dir, "hello.txt"))).toBe(true);
  });
});
