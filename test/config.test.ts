import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { describeConfigSources, loadEffectiveConfig } from "../src/engine/config.ts";

describe("loadEffectiveConfig (#38)", () => {
  let home: string;
  let ws: string;

  beforeEach(() => {
    home = makeTempDir("cfg-home-");
    ws = makeTempDir("cfg-ws-");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    delete process.env["KIMI_MODEL"];
    delete process.env["OPENAI_MODEL"];
    delete process.env["OPENAI_API_KEY"];
  });

  it("returns empty config when no files exist", async () => {
    const config = await loadEffectiveConfig(ws, home);
    expect(config.apiKey).toBeUndefined();
    expect(config.sources).toEqual({});
  });

  it("merges user < project < env per field and records sources", async () => {
    await mkdir(join(home, ".mini-agent"), { recursive: true });
    await writeFile(
      join(home, ".mini-agent", "config.json"),
      JSON.stringify({ api_key: "user-key", base_url: "https://user.example", model: "user-model" }),
    );
    await writeFile(
      join(ws, ".agent.json"),
      JSON.stringify({ api_key: "project-key", model: "project-model" }),
    );
    process.env["KIMI_MODEL"] = "env-model";

    const config = await loadEffectiveConfig(ws, home);

    expect(config.apiKey).toBe("project-key"); // 项目级压用户级
    expect(config.baseUrl).toBe("https://user.example"); // 只有用户级有
    expect(config.model).toBe("env-model"); // env 最高
    expect(config.sources).toEqual({
      apiKey: "project:.agent.json",
      baseUrl: "user:config.json",
      model: "env:KIMI_MODEL",
    });
  });

  it("resolves system_prompt_file relative to the config file's directory", async () => {
    await writeFile(join(ws, ".agent.json"), JSON.stringify({ system_prompt_file: "prompts/sys.md" }));
    const config = await loadEffectiveConfig(ws, home);
    expect(config.systemPromptFile).toBe(join(ws, "prompts", "sys.md"));
    expect(config.sources["systemPromptFile"]).toBe("project:.agent.json");
  });

  it("source description never includes values", async () => {
    await mkdir(join(home, ".mini-agent"), { recursive: true });
    await writeFile(join(home, ".mini-agent", "config.json"), JSON.stringify({ api_key: "secret-key-123" }));
    const config = await loadEffectiveConfig(ws, home);
    const text = describeConfigSources(config, "kimi-code 订阅 OAuth");
    expect(text).toContain("apiKey ← user:config.json");
    expect(text).not.toContain("secret-key-123");
  });

  it("provider 字段来自配置文件并记录来源", async () => {
    await writeFile(join(ws, ".agent.json"), JSON.stringify({ provider: "openai" }));
    const config = await loadEffectiveConfig(ws, home);
    expect(config.provider).toBe("openai");
    expect(config.sources["provider"]).toBe("project:.agent.json");
  });

  it("OPENAI_* env 生效、推断 provider=openai；KIMI_* 优先", async () => {
    process.env["OPENAI_MODEL"] = "gpt-4o";
    const config = await loadEffectiveConfig(ws, home);
    expect(config.model).toBe("gpt-4o");
    expect(config.sources["model"]).toBe("env:OPENAI_MODEL");
    expect(config.provider).toBe("openai"); // 命中 OPENAI_* 且未显式配置 → 推断
    expect(config.sources["provider"]).toContain("OPENAI_");

    process.env["KIMI_MODEL"] = "kimi-env";
    const config2 = await loadEffectiveConfig(ws, home);
    expect(config2.model).toBe("kimi-env"); // KIMI_* 优先于 OPENAI_*
    expect(config2.sources["model"]).toBe("env:KIMI_MODEL");
  });

  it("显式 provider 不被 OPENAI_* env 覆盖", async () => {
    await writeFile(join(ws, ".agent.json"), JSON.stringify({ provider: "kimi" }));
    process.env["OPENAI_MODEL"] = "gpt-4o";
    const config = await loadEffectiveConfig(ws, home);
    expect(config.provider).toBe("kimi");
    expect(config.model).toBe("gpt-4o");
    expect(config.sources["model"]).toBe("env:OPENAI_MODEL");
  });
});

describe("system prompt override (#39)", () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = makeTempDir("prompt-ws-");
    home = makeTempDir("prompt-home-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("project .agent.md overrides the built-in system prompt", async () => {
    await writeFile(join(dir, ".agent.md"), "你是只回答 ok 的机器人");
    const agent = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir, homeDir: home });

    expect(agent.systemPrompt).toBe("你是只回答 ok 的机器人");
  });

  it("explicit system_prompt_file wins over .agent.md", async () => {
    await writeFile(join(dir, ".agent.md"), "agent-md prompt");
    await mkdir(join(dir, "p"), { recursive: true });
    await writeFile(join(dir, "p", "sys.md"), "explicit file prompt");
    await writeFile(join(dir, ".agent.json"), JSON.stringify({ system_prompt_file: "p/sys.md" }));

    const agent = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir, homeDir: home });
    expect(agent.systemPrompt).toBe("explicit file prompt");
  });

  it("falls back to the built-in default without any override", async () => {
    const agent = await bootstrap({ workspace: dir, fake: true, sessionRoot: dir, homeDir: home });
    expect(agent.systemPrompt).toContain("minimal coding agent");
  });
});
