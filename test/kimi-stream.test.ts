import { describe, expect, it } from "vitest";
import { ChunkConverter, parseSseData, type ChatChunk } from "../src/engine/llm/kimi-stream.js";

const chunk = (obj: object): ChatChunk => obj as ChatChunk;

describe("kimi-stream", () => {
  it("parses sse data lines, ignoring comments and [DONE]", () => {
    const raw = [
      ": keep-alive",
      'data: {"id":"1","choices":[{"delta":{"content":"he"}}]}',
      "",
      'data: {"id":"1","choices":[{"delta":{"content":"llo"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");

    expect(parseSseData(raw)).toEqual([
      '{"id":"1","choices":[{"delta":{"content":"he"}}]}',
      '{"id":"1","choices":[{"delta":{"content":"llo"}}]}',
    ]);
  });

  it("converts text and reasoning deltas to text/think events", () => {
    const converter = new ChunkConverter();

    const events = [
      ...converter.push(chunk({ choices: [{ delta: { reasoning_content: "hmm" } }] })),
      ...converter.push(chunk({ choices: [{ delta: { content: "Hello" } }] })),
      ...converter.push(chunk({ choices: [{ delta: { content: " world" } }] })),
      ...converter.push(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] })),
    ];

    expect(events).toEqual([
      { type: "think", text: "hmm" },
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("buffers tool_call argument fragments by index and emits on finish", () => {
    const converter = new ChunkConverter();

    const events = [
      ...converter.push(
        chunk({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "" } }] } },
          ],
        }),
      ),
      ...converter.push(
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"hel' } }] } }] }),
      ),
      ...converter.push(
        chunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'lo.txt","content":"hi"}' } }] } }],
        }),
      ),
      ...converter.push(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })),
    ];

    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "write_file",
        args: { path: "hello.txt", content: "hi" },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });
});
