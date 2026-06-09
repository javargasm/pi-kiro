import { describe, expect, it } from "vitest";
import { findJsonEnd, parseKiroEvent, parseKiroEvents } from "../src/event-parser";

describe("findJsonEnd", () => {
  it("finds matching close brace", () => {
    expect(findJsonEnd('{"a":1}', 0)).toBe(6);
  });
  it("handles nested objects", () => {
    expect(findJsonEnd('{"a":{"b":2}}', 0)).toBe(12);
  });
  it("ignores braces inside strings", () => {
    expect(findJsonEnd('{"a":"}"}', 0)).toBe(8);
  });
  it("handles escape sequences", () => {
    expect(findJsonEnd('{"a":"\\""}', 0)).toBe(9);
  });
  it("returns -1 for incomplete JSON", () => {
    expect(findJsonEnd('{"a":1', 0)).toBe(-1);
  });
});

describe("parseKiroEvent", () => {
  it("returns content event", () => {
    expect(parseKiroEvent({ content: "hi" })).toEqual({ type: "content", data: "hi" });
  });
  it("returns toolUse with string input", () => {
    const e = parseKiroEvent({ name: "bash", toolUseId: "t1", input: '{"cmd":"ls"}', stop: true });
    expect(e).toEqual({
      type: "toolUse",
      data: { name: "bash", toolUseId: "t1", input: '{"cmd":"ls"}', stop: true },
    });
  });
  it("returns toolUse with object input serialized", () => {
    const e = parseKiroEvent({ name: "bash", toolUseId: "t1", input: { cmd: "ls" } });
    expect(e?.type).toBe("toolUse");
    if (e?.type === "toolUse") expect(e.data.input).toBe('{"cmd":"ls"}');
  });
  it("returns toolUse with empty object input as empty string", () => {
    const e = parseKiroEvent({ name: "x", toolUseId: "t", input: {} });
    if (e?.type === "toolUse") expect(e.data.input).toBe("");
  });
  it("returns toolUseInput when name is absent", () => {
    expect(parseKiroEvent({ input: "delta" })).toEqual({
      type: "toolUseInput",
      data: { input: "delta" },
    });
  });
  it("returns toolUseStop for bare {stop:true}", () => {
    expect(parseKiroEvent({ stop: true })).toEqual({ type: "toolUseStop", data: { stop: true } });
  });
  it("returns contextUsage", () => {
    expect(parseKiroEvent({ contextUsagePercentage: 45 })).toEqual({
      type: "contextUsage",
      data: { contextUsagePercentage: 45 },
    });
  });
  it("returns usage", () => {
    expect(parseKiroEvent({ usage: { inputTokens: 100, outputTokens: 50 } })).toEqual({
      type: "usage",
      data: { inputTokens: 100, outputTokens: 50 },
    });
  });
  it("returns error event", () => {
    expect(parseKiroEvent({ error: "ThrottlingException", message: "wait" })).toEqual({
      type: "error",
      data: { error: "ThrottlingException", message: "wait" },
    });
  });
  it("returns error for capitalized Error key", () => {
    expect(parseKiroEvent({ Error: "X", Message: "Y" })).toEqual({
      type: "error",
      data: { error: "X", message: "Y" },
    });
  });
  it("returns followupPrompt", () => {
    expect(parseKiroEvent({ followupPrompt: "p" })).toEqual({
      type: "followupPrompt",
      data: "p",
    });
  });
  it("returns reasoning event with text and signature", () => {
    const e = parseKiroEvent({
      reasoningText: { text: "I should search for this", signature: "abc123" },
    });
    expect(e).toEqual({
      type: "reasoning",
      data: { text: "I should search for this", signature: "abc123" },
    });
  });
  it("returns reasoning event without signature", () => {
    const e = parseKiroEvent({ reasoningText: { text: "thinking..." } });
    expect(e).toEqual({
      type: "reasoning",
      data: { text: "thinking...", signature: undefined },
    });
  });
  it("returns null for unknown shapes", () => {
    expect(parseKiroEvent({ random: "key" })).toBeNull();
  });
});

describe("parseKiroEvents", () => {
  it("extracts multiple events from a single buffer", () => {
    const buf = '{"content":"a"}{"content":"b"}{"contextUsagePercentage":10}';
    const { events, remaining } = parseKiroEvents(buf);
    expect(events).toHaveLength(3);
    expect(remaining).toBe("");
  });

  it("preserves incomplete trailing JSON as remaining", () => {
    const buf = '{"content":"done"}{"content":"half';
    const { events, remaining } = parseKiroEvents(buf);
    expect(events).toHaveLength(1);
    expect(remaining).toBe('{"content":"half');
  });

  it("skips garbage between events", () => {
    const buf = 'GARBAGE{"content":"a"}MORE{"content":"b"}';
    const { events } = parseKiroEvents(buf);
    expect(events).toHaveLength(2);
  });

  it("handles events with nested JSON in string values", () => {
    const buf = '{"name":"bash","toolUseId":"tc1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    const { events } = parseKiroEvents(buf);
    expect(events).toHaveLength(1);
    if (events[0]?.type === "toolUse") {
      expect(events[0].data.input).toBe('{"cmd":"ls"}');
    }
  });

  it("handles empty buffer", () => {
    expect(parseKiroEvents("")).toEqual({ events: [], remaining: "" });
  });

  it("extracts reasoning events from buffer", () => {
    const buf = '{"reasoningText":{"text":"Let me think","signature":"sig1"}}{"content":"result"}';
    const { events } = parseKiroEvents(buf);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "reasoning",
      data: { text: "Let me think", signature: "sig1" },
    });
    expect(events[1]).toEqual({ type: "content", data: "result" });
  });
});
