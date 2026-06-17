import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildHistory,
  collapseAgenticLoops,
  convertImagesToKiro,
  getContentText,
  type KiroHistoryEntry,
  MAX_KIRO_IMAGE_BYTES,
  MAX_KIRO_IMAGES,
  normalizeMessages,
  TOOL_RESULT_LIMIT,
  toKiroToolUseId,
  truncate,
} from "../src/transform";

const ts = Date.now();
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: ts });

const assistant = (text: string, opts?: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "kiro-api",
  provider: "kiro",
  model: "test",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: ts,
  ...opts,
});

const toolResult = (id: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "t",
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});

describe("truncate", () => {
  it("returns input unchanged below limit", () => {
    expect(truncate("short", 100)).toBe("short");
  });
  it("truncates above limit with marker", () => {
    const r = truncate("a".repeat(100), 50);
    expect(r).toContain("[TRUNCATED]");
    expect(r.length).toBeLessThan(100);
  });
  it("preserves start and end", () => {
    const r = truncate(`START${"x".repeat(100)}END`, 30);
    expect(r.startsWith("START")).toBe(true);
    expect(r.endsWith("END")).toBe(true);
  });
});

describe("normalizeMessages", () => {
  it("drops errored assistant messages", () => {
    const msgs: Message[] = [user("hi"), assistant("oops", { stopReason: "error" }), user("retry")];
    expect(normalizeMessages(msgs)).toHaveLength(2);
  });
  it("drops aborted assistant messages", () => {
    expect(
      normalizeMessages([user("hi"), assistant("x", { stopReason: "aborted" })]),
    ).toHaveLength(1);
  });
  it("keeps successful assistant messages", () => {
    expect(normalizeMessages([user("hi"), assistant("ok")])).toHaveLength(2);
  });
});

describe("getContentText", () => {
  it("reads string user content", () => {
    expect(getContentText(user("hello"))).toBe("hello");
  });
  it("reads tool result", () => {
    expect(getContentText(toolResult("tc1", "result"))).toBe("result");
  });
  it("concatenates thinking + text", () => {
    const msg = assistant("");
    msg.content = [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
    ];
    expect(getContentText(msg)).toBe("hmmanswer");
  });
});

describe("convertImagesToKiro", () => {
  it("derives format from mime", () => {
    const { images, omitted } = convertImagesToKiro([{ mimeType: "image/png", data: "b64" }]);
    expect(images).toEqual([{ format: "png", source: { bytes: "b64" } }]);
    expect(omitted).toBe(0);
  });
  it("falls back to png for malformed mime", () => {
    const { images, omitted } = convertImagesToKiro([{ mimeType: "weird", data: "b64" }]);
    expect(images).toEqual([{ format: "png", source: { bytes: "b64" } }]);
    expect(omitted).toBe(0);
  });

  it("omits images exceeding MAX_KIRO_IMAGE_BYTES", () => {
    // base64 encodes 3 bytes per 4 chars.
    const oversized = "A".repeat(Math.ceil(((MAX_KIRO_IMAGE_BYTES + 1) * 4) / 3));
    const small = "QQ=="; // 1 byte
    const { images, omitted } = convertImagesToKiro([
      { mimeType: "image/png", data: oversized },
      { mimeType: "image/jpeg", data: small },
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]?.format).toBe("jpeg");
    expect(omitted).toBe(1);
  });

  it("omits images exceeding MAX_KIRO_IMAGES count", () => {
    const imgs = Array.from({ length: 6 }, (_, i) => ({
      mimeType: `image/png`,
      data: `img${i}`,
    }));
    const { images, omitted } = convertImagesToKiro(imgs);
    expect(images).toHaveLength(MAX_KIRO_IMAGES);
    expect(omitted).toBe(2);
  });
});

describe("collapseAgenticLoops", () => {
  const asstWithTool = (text: string, toolName: string): KiroHistoryEntry => ({
    assistantResponseMessage: {
      content: text,
      toolUses: [{ name: toolName, toolUseId: `id-${toolName}`, input: {} }],
    },
  });

  const userWithToolResult = (toolName: string): KiroHistoryEntry => ({
    userInputMessage: {
      content: "Tool results provided.",
      modelId: "M",
      origin: "KIRO_CLI" as const,
      userInputMessageContext: {
        toolResults: [{
          content: [{ text: "ok" }],
          status: "success" as const,
          toolUseId: `id-${toolName}`,
        }],
      },
    },
  });

  it("returns unchanged for short history (< 4 entries)", () => {
    const h: KiroHistoryEntry[] = [
      { userInputMessage: { content: "hi", modelId: "M", origin: "KIRO_CLI" } },
    ];
    expect(collapseAgenticLoops(h)).toEqual(h);
  });

  it("returns unchanged for single tool-use pair", () => {
    const h: KiroHistoryEntry[] = [
      { userInputMessage: { content: "hi", modelId: "M", origin: "KIRO_CLI" } },
      asstWithTool("Let me check", "bash"),
      userWithToolResult("bash"),
      { userInputMessage: { content: "next", modelId: "M", origin: "KIRO_CLI" } },
    ];
    const result = collapseAgenticLoops(h);
    expect(result).toHaveLength(4);
    expect(result[1]?.assistantResponseMessage?.content).toBe("Let me check");
  });

  it("collapses 3 consecutive tool-use pairs", () => {
    const h: KiroHistoryEntry[] = [
      asstWithTool("First thought", "bash"),
      userWithToolResult("bash"),
      asstWithTool("Second thought", "read"),
      userWithToolResult("read"),
      asstWithTool("Third thought", "write"),
      userWithToolResult("write"),
    ];
    const result = collapseAgenticLoops(h);
    expect(result).toHaveLength(6); // same count, but text replaced
    // First pair keeps its text
    expect(result[0]?.assistantResponseMessage?.content).toBe("First thought");
    // Subsequent pairs get placeholder text
    expect(result[2]?.assistantResponseMessage?.content).toBe("[tool calling continues]");
    expect(result[4]?.assistantResponseMessage?.content).toBe("[tool calling continues]");
    // Tool uses are preserved on all
    expect(result[2]?.assistantResponseMessage?.toolUses?.[0]?.name).toBe("read");
    expect(result[4]?.assistantResponseMessage?.toolUses?.[0]?.name).toBe("write");
  });

  it("does not collapse non-tool entries between loops", () => {
    const h: KiroHistoryEntry[] = [
      asstWithTool("First", "bash"),
      userWithToolResult("bash"),
      { userInputMessage: { content: "plain user msg", modelId: "M", origin: "KIRO_CLI" } },
      asstWithTool("After break", "read"),
      userWithToolResult("read"),
    ];
    const result = collapseAgenticLoops(h);
    // The plain user message breaks the sequence, so no collapse
    expect(result[0]?.assistantResponseMessage?.content).toBe("First");
    expect(result[2]?.userInputMessage?.content).toBe("plain user msg");
    expect(result[3]?.assistantResponseMessage?.content).toBe("After break");
  });
});

describe("buildHistory", () => {
  describe("toolUseId canonicalization", () => {
    it("keeps native Kiro tooluse IDs unchanged", () => {
      expect(toKiroToolUseId("tooluse_abcABC123")).toBe("tooluse_abcABC123");
    });

    it("maps non-Kiro tool IDs to deterministic Kiro-compatible IDs", () => {
      const canonical = toKiroToolUseId("call_abc|fc_def");
      expect(canonical).toMatch(/^tooluse_[a-f0-9]{22}$/);
      expect(canonical).toBe(toKiroToolUseId("call_abc|fc_def"));
      expect(canonical).not.toContain("|");
    });

    it("canonicalizes assistant toolUses and matching toolResults together", () => {
      const rawId = "call_abc123|fc_def456";
      const a = assistant("");
      a.content = [{ type: "toolCall", id: rawId, name: "bash", arguments: { cmd: "ls" } }];
      const msgs: Message[] = [user("go"), a, toolResult(rawId, "ok"), user("next")];

      const { history } = buildHistory(msgs, "M");
      const assistantEntry = history.find((h) => h.assistantResponseMessage?.toolUses);
      const resultEntry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      const toolUseId = assistantEntry?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;
      const toolResultId = resultEntry?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId;

      expect(toolUseId).toMatch(/^tooluse_[a-f0-9]{22}$/);
      expect(toolUseId).toBe(toolResultId);
      expect(toolUseId).not.toContain("|");
    });
  });

  it("returns empty history for single user", () => {
    const { history } = buildHistory([user("Hello")], "M");
    expect(history).toHaveLength(0);
  });

  it("prepends system prompt to first user message", () => {
    const msgs: Message[] = [user("first"), assistant("reply"), user("second")];
    const { history, systemPrepended } = buildHistory(msgs, "M", "Be helpful");
    expect(systemPrepended).toBe(true);
    expect(history[0]?.userInputMessage?.content).toMatch(/^Be helpful/);
  });

  it("uses origin: KIRO_CLI", () => {
    const msgs: Message[] = [user("first"), assistant("reply"), user("second")];
    const { history } = buildHistory(msgs, "M");
    expect(history[0]?.userInputMessage?.origin).toBe("KIRO_CLI");
  });

  it("converts assistant tool calls to toolUses", () => {
    const a = assistant("");
    a.content = [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }];
    const msgs: Message[] = [user("go"), a, toolResult("tc1", "ok"), user("next")];
    const { history } = buildHistory(msgs, "M");
    const entry = history.find((h) => h.assistantResponseMessage?.toolUses);
    expect(entry?.assistantResponseMessage?.toolUses?.[0]?.name).toBe("bash");
  });

  it("batches consecutive tool results", () => {
    const a = assistant("");
    a.content = [
      { type: "toolCall", id: "tc1", name: "a", arguments: {} },
      { type: "toolCall", id: "tc2", name: "b", arguments: {} },
    ];
    const msgs: Message[] = [
      user("go"),
      a,
      toolResult("tc1", "r1"),
      toolResult("tc2", "r2"),
      user("next"),
    ];
    const { history } = buildHistory(msgs, "M");
    const entry = history.find(
      (h) => h.userInputMessage?.userInputMessageContext?.toolResults,
    );
    expect(entry?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(2);
  });

  it("truncates tool results over TOOL_RESULT_LIMIT", () => {
    const a = assistant("");
    a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
    const msgs: Message[] = [
      user("go"),
      a,
      toolResult("tc1", "x".repeat(TOOL_RESULT_LIMIT + 1000)),
      user("next"),
    ];
    const { history } = buildHistory(msgs, "M");
    const entry = history.find(
      (h) => h.userInputMessage?.userInputMessageContext?.toolResults,
    );
    const text = entry?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.content[0]?.text ?? "";
    expect(text).toContain("[TRUNCATED]");
  });

  it("merges consecutive user messages (no synthetic padding)", () => {
    const msgs: Message[] = [user("first"), user("second"), assistant("reply"), user("third")];
    const { history } = buildHistory(msgs, "M");
    expect(JSON.stringify(history)).not.toContain('"Continue"');
    expect(history[0]?.userInputMessage?.content).toContain("first");
    expect(history[0]?.userInputMessage?.content).toContain("second");
  });

  it("merges tool results into previous user message", () => {
    const a = assistant("");
    a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
    const msgs: Message[] = [user("go"), user("more"), a, toolResult("tc1", "ok"), user("next")];
    const { history } = buildHistory(msgs, "M");
    expect(JSON.stringify(history)).not.toContain('"Continue"');
  });

  it("maintains user/assistant alternation via merging", () => {
    const msgs: Message[] = [
      user("a"),
      user("b"),
      user("c"),
      assistant("reply"),
      user("d"),
    ];
    const { history } = buildHistory(msgs, "M");
    for (let i = 0; i < history.length - 1; i++) {
      const curr = history[i];
      const next = history[i + 1];
      if (curr?.userInputMessage) expect(next?.assistantResponseMessage).toBeDefined();
      if (curr?.assistantResponseMessage) expect(next?.userInputMessage).toBeDefined();
    }
  });

  it("serializes thinking blocks into assistant content", () => {
    const a = assistant("");
    a.content = [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
    ];
    const msgs: Message[] = [user("q"), a, user("followup")];
    const { history } = buildHistory(msgs, "M");
    const arm = history.find((h) => h.assistantResponseMessage);
    expect(arm?.assistantResponseMessage?.content).toContain("<thinking>reasoning</thinking>");
    expect(arm?.assistantResponseMessage?.content).toContain("answer");
  });

  it("drops empty assistant messages with no content and no tool uses", () => {
    const a = assistant("");
    a.content = [];
    const msgs: Message[] = [user("q"), a, user("followup")];
    const { history } = buildHistory(msgs, "M");
    expect(history.find((h) => h.assistantResponseMessage)).toBeUndefined();
  });
});
