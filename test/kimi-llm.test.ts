import { describe, expect, it, vi } from "vitest";

import { classifyHttpError, KimiLLM } from "../src/engine/llm/kimi.ts";

const CREDS = { apiKey: "k", baseUrl: "https://api.test/v1", model: "m" };
const noSleep = () => Promise.resolve();

function makeLlm(fetchImpl: ReturnType<typeof vi.fn>, maxRetries = 2) {
  return new KimiLLM(CREDS, {
    fetchFn: fetchImpl as unknown as typeof fetch,
    maxRetries,
    sleep: noSleep,
  });
}

function errorResponse(status: number, body = "err"): Response {
  return {
    ok: false,
    status,
    body: null,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

async function drain(llm: KimiLLM): Promise<void> {
  for await (const event of llm.request([{ role: "user", content: "hi" }], [])) void event;
}

describe("classifyHttpError (#40)", () => {
  it("401/403 → 凭证问题，带可操作建议", () => {
    expect(classifyHttpError(401, "").message).toContain("凭证问题");
    expect(classifyHttpError(401, "").message).toContain("KIMI_API_KEY");
    expect(classifyHttpError(403, "x").message).toContain("凭证问题");
  });

  it("429 → 限流；5xx → 服务故障", () => {
    expect(classifyHttpError(429, "").message).toContain("限流");
    expect(classifyHttpError(500, "").message).toContain("服务故障");
    expect(classifyHttpError(502, "").message).toContain("服务故障");
  });
});

describe("KimiLLM retries (#41)", () => {
  it("4xx does not retry and throws the classified error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    await expect(drain(makeLlm(fetchMock))).rejects.toThrow("凭证问题");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx retries with backoff then succeeds", async () => {
    const sse = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n";
    const okResponse = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(errorResponse(502))
      .mockResolvedValue(okResponse);

    await drain(makeLlm(fetchMock));

    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 次失败 + 第 3 次成功
  });

  it("network errors retry then give up with a classified message", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(drain(makeLlm(fetchMock))).rejects.toThrow("网络错误");
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("5xx beyond the retry cap throws the classified 5xx error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500));
    await expect(drain(makeLlm(fetchMock))).rejects.toThrow("服务故障");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
