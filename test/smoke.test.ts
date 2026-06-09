import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1).toBe(1);
  });

  it("imports pi-ai types", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "kiro-api",
      provider: "kiro",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    expect(msg.role).toBe("assistant");
  });
});
