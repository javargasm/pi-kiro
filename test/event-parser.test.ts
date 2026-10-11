import { describe, expect, it } from "vitest";
import { findJsonEnd, parseKiroEvent, parseKiroEvents, detectEventStreamException } from "../src/event-parser";

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
  it("does NOT treat a metering frame (numeric usage) as a usage event", () => {
    // Real frame captured from Kiro CLI:
    // {"unit":"credit","unitPlural":"credits","usage":0.17618616013267}
    // The numeric `usage` is a credit cost, not token counts. Before the
    // typeof guard this returned a bogus usage event with undefined tokens,
    // clobbering a real usageEvent earlier in the stream.
    expect(
      parseKiroEvent({ unit: "credit", unitPlural: "credits", usage: 0.17618616013267 }),
    ).toBeNull();
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
  it("ignores followupPrompt frames", () => {
    expect(parseKiroEvent({ followupPrompt: "p" })).toBeNull();
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
  it("returns a metadata event for an authoritative stopReason frame", () => {
    expect(parseKiroEvent({ stopReason: "TOOL_USE" })).toEqual({
      type: "metadata",
      data: { stopReason: "TOOL_USE" },
    });
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

describe("AWS Event Stream exception framing (vnd.amazon.eventstream)", () => {
  // Simulate the text-decoded bytes of an exception message: header name +
  // value-type byte (0x07 = string) + 2-byte big-endian length + value, then
  // the JSON payload (which carries only the message, never the type).
  function header(name: string, value: string): string {
    const len = value.length;
    return `:${name}\x07${String.fromCharCode((len >> 8) & 0xff)}${String.fromCharCode(len & 0xff)}${value}`;
  }
  function exceptionFrame(type: string, message: string): string {
    return (
      "\x00\x00\x00\x2a\x00\x00\x00\x1f" + // junk prelude bytes (length/CRC)
      header("message-type", "exception") +
      header("exception-type", type) +
      header("content-type", "application/json") +
      `{"message":${JSON.stringify(message)}}`
    );
  }

  it("detectEventStreamException pulls the type from the header and message from the payload", () => {
    const exc = detectEventStreamException(exceptionFrame("ThrottlingException", "slow down"));
    expect(exc).not.toBeNull();
    expect(exc?.type).toBe("ThrottlingException");
    expect(exc?.message).toBe("slow down");
  });

  it("surfaces an exception frame as an error event (payload has no `error` key)", () => {
    const { events } = parseKiroEvents(exceptionFrame("InternalServerException", "boom"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.data.error).toBe("InternalServerException");
      expect(err.data.message).toBe("boom");
    }
  });

  it("still extracts content events that precede an exception frame", () => {
    const buffer = '{"content":"partial answer"}' + exceptionFrame("ThrottlingException", "rate");
    const { events } = parseKiroEvents(buffer);
    expect(events.find((e) => e.type === "content")).toBeDefined();
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") expect(err.data.error).toBe("ThrottlingException");
  });

  it("does NOT false-positive on normal content that mentions an exception", () => {
    const { events } = parseKiroEvents(
      '{"content":"wrap it in a try/catch for the Exception"}{"contextUsagePercentage":5}',
    );
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(detectEventStreamException("just some text about an Exception class")).toBeNull();
  });

  it("does not double-emit when the payload already carries an `error` key", () => {
    const { events } = parseKiroEvents('{"error":"ValidationException","message":"bad input"}');
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });
});

describe("metadataEvent stopReason extraction", () => {
  it("emits a metadata event for a standalone metadataEvent frame", () => {
    const { events } = parseKiroEvents(
      ":event-type metadataEvent:content-type application/json:message-type event" +
        '{"stopReason":"END_TURN"}',
    );
    const meta = events.find((e) => e.type === "metadata");
    expect(meta).toBeDefined();
    if (meta?.type === "metadata") expect(meta.data.stopReason).toBe("END_TURN");
  });

  it("does not emit a metadata event for a clean text stream (no stopReason)", () => {
    const { events } = parseKiroEvents('{"content":"hi"}{"contextUsagePercentage":5}');
    expect(events.find((e) => e.type === "metadata")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });
});
