import { describe, expect, it, vi } from "vitest";

import { ToolExecutor } from "../src/engine/tools/executor.ts";
import { registerWebTools } from "../src/engine/tools/web.ts";

function mockFetchResponse(init: { status?: number; json?: unknown; text?: string }): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "S",
    json: () => Promise.resolve(init.json),
    text: () => Promise.resolve(init.text ?? ""),
  } as unknown as Response;
}

function setup(fetchImpl: ReturnType<typeof vi.fn>) {
  const executor = new ToolExecutor();
  registerWebTools(executor, {
    apiKey: "test-token",
    baseUrl: "https://api.kimi.com/coding/v1",
    fetchFn: fetchImpl as unknown as typeof fetch,
  });
  return executor;
}

describe("web_search (#35)", () => {
  it("posts text_query with Bearer and maps title/url/snippet only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse({
        json: {
          search_results: [
            {
              title: "T1",
              url: "https://a.com",
              snippet: "snip",
              content: "HUGE FULLTEXT SHOULD BE DROPPED",
              site_name: "A",
              date: "2026-01-01",
              icon: "x",
            },
          ],
        },
      }),
    );
    const executor = setup(fetchMock);

    const result = await executor.execute("web_search", { text_query: "rust ownership" });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.kimi.com/coding/v1/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");
    expect(JSON.parse(String(init.body))).toEqual({ text_query: "rust ownership" });

    expect(result.output).toContain("Title: T1");
    expect(result.output).toContain("URL: https://a.com");
    expect(result.output).toContain("Snippet: snip");
    expect(result.output).toContain("Site: A");
    expect(result.output).not.toContain("HUGE FULLTEXT");
  });

  it("classifies 401 as an auth error without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse({ status: 401, json: { error: { message: "Invalid Authentication" } } }),
    );
    const executor = setup(fetchMock);

    const result = await executor.execute("web_search", { text_query: "x" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("认证/额度错误");
    expect(result.output).toContain("Invalid Authentication");
    expect(fetchMock).toHaveBeenCalledTimes(1); // 不重试
  });
});

describe("web_fetch (#36)", () => {
  it("validates http(s) URLs", async () => {
    const executor = setup(vi.fn());
    for (const bad of ["ftp://x", "not-a-url", "file:///etc/passwd"]) {
      const result = await executor.execute("web_fetch", { url: bad });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("invalid url");
    }
  });

  it("posts the url and returns markdown body, truncated at the hard cap", async () => {
    const markdown = "# Page\n" + "m".repeat(60 * 1024);
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ text: markdown }));
    const executor = setup(fetchMock);

    const result = await executor.execute("web_fetch", { url: "https://example.com" });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe("text/markdown");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://example.com" });
    expect(result.output).toContain("# Page");
    expect(result.output.length).toBeLessThan(markdown.length);
    expect(result.output).toContain("[...truncated]");
  });
});
