import { mkdirSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createLLM } from "../src/engine/llm/factory.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

describe("createLLM 工厂（#55 provider 泛化）", () => {
  it("kimi 默认 baseUrl/model；显式 apiKey 直接生效", async () => {
    const built = await createLLM({ apiKey: "k", homeDir: makeTempDir("empty-") });
    expect(built.provider).toBe("kimi");
    expect(built.model).toBe("kimi-for-coding");
    expect(built.webCredentials).toEqual({ apiKey: "k", baseUrl: "https://api.kimi.com/coding/v1" });
  });

  it("openai 默认 baseUrl/model", async () => {
    const built = await createLLM({ provider: "openai", apiKey: "k" });
    expect(built.provider).toBe("openai");
    expect(built.model).toBe("gpt-4o-mini");
    expect(built.webCredentials?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("自定义兼容端点必须显式给 base_url/model", async () => {
    await expect(createLLM({ provider: "vllm", apiKey: "k" })).rejects.toThrow("base_url");
    const built = await createLLM({
      provider: "vllm",
      apiKey: "k",
      baseUrl: "http://localhost:8000/v1",
      model: "qwen",
    });
    expect(built.model).toBe("qwen");
    expect(built.webCredentials).toEqual({ apiKey: "k", baseUrl: "http://localhost:8000/v1" });
  });

  it("kimi 无显式 apiKey 时读订阅 OAuth 兜底", async () => {
    const home = makeTempDir("oauth-");
    try {
      mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
      const future = Math.floor(Date.now() / 1000) + 3600;
      writeFileSync(
        join(home, ".kimi-code", "credentials", "kimi-code.json"),
        JSON.stringify({ access_token: "token-1", expires_at: future }),
      );
      const built = await createLLM({ homeDir: home });
      expect(built.webCredentials?.apiKey).toBe("token-1");
      expect(built.model).toBe("kimi-for-coding");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("订阅 token 过期时报错提示刷新", async () => {
    const home = makeTempDir("oauth-");
    try {
      mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
      writeFileSync(
        join(home, ".kimi-code", "credentials", "kimi-code.json"),
        JSON.stringify({ access_token: "token-1", expires_at: 0 }),
      );
      await expect(createLLM({ homeDir: home })).rejects.toThrow("已过期");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("kimi 无任何凭证时报错并给出 kimi 提示", async () => {
    await expect(createLLM({ homeDir: makeTempDir("empty-") })).rejects.toThrow("KIMI_API_KEY");
  });
});
