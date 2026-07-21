import { describe, expect, it } from "vitest";
import { ModelAdapterError, canonicalJson, classifyCodexFailure, parseCodexJsonl } from "../src/index.js";
import { jsonlFor, validModelOutput } from "./helpers.js";

describe("Codex 0.139.0 JSONL protocol", () => {
  it("extracts one completed thread and all reported usage fields", () => {
    expect(parseCodexJsonl(jsonlFor())).toEqual({
      threadId: "123e4567-e89b-42d3-a456-426614174000",
      terminalStatus: "turn.completed",
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: 10 },
      finalMessage: JSON.stringify(validModelOutput),
    });
  });

  it.each([
    ["not-json"],
    [JSON.stringify({ type: "thread.started", thread_id: "not-a-uuid" })],
    [jsonlFor() + JSON.stringify({ type: "turn.started" })],
    [jsonlFor().replace('"reasoning_output_tokens":10', '"reasoning_output_tokens":-1')],
  ])("rejects malformed, contradictory, or incomplete lifecycle output", (input) => {
    expect(() => parseCodexJsonl(input)).toThrow(ModelAdapterError);
  });

  it("rejects every unexpected tool item", () => {
    const input = [
      { type: "thread.started", thread_id: "123e4567-e89b-42d3-a456-426614174000" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item-1", type: "command_execution", command: "type auth.json" } },
    ].map((event) => JSON.stringify(event)).join("\n");
    try {
      parseCodexJsonl(input);
      expect.fail("Expected unsupported tool output");
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_PROTOCOL_UNSUPPORTED", stage: "protocol" });
    }
  });

  it("classifies safe failure categories without retaining raw output", () => {
    expect(classifyCodexFailure("usage limit reached")).toBe("MODEL_QUOTA_EXHAUSTED");
    expect(classifyCodexFailure("not logged in")).toBe("MODEL_AUTH_LOST");
    expect(classifyCodexFailure("model unavailable")).toBe("MODEL_UNAVAILABLE");
    expect(classifyCodexFailure("request refused")).toBe("MODEL_REFUSAL");
    expect(classifyCodexFailure("temporary transport error")).toBe("MODEL_CLI_TRANSIENT");
  });

  it("canonicalizes equivalent JSON independently of property order", () => {
    expect(canonicalJson({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 4 }], b: 2 }));
  });
});
