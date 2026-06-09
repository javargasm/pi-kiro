// pi-mono equivalent: context-overflow.test.ts — oversized prompts surface
// as context_length_exceeded so pi-mono's isContextOverflow() matches.
// SKIP unless KIRO_LIVE_TEST=1.

import { isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { complete, LIVE, suiteModel, suiteOptions } from "./_harness";

describe.skipIf(!LIVE)("[live] context-overflow: oversize prompts", () => {
  it("huge prompt errors with context_length_exceeded marker", async () => {
    const huge = "x ".repeat(500_000); // ~1MB
    const response = await complete(
      suiteModel(),
      { messages: [{ role: "user", content: huge, timestamp: Date.now() }] },
      suiteOptions(),
    );
    // Either errors with the marker, or errors with a 413/too-big body.
    expect(response.stopReason).toBe("error");
    expect(isContextOverflow(response, suiteModel().contextWindow)).toBe(true);
  }, 120000);
});
