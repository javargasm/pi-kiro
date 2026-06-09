import { describe, expect, it } from "vitest";
import {
  COMPACTION_THRESHOLD_PCT,
  SYSTEM_SEED_ACK,
  SYSTEM_SEED_INSTRUCTION,
  TOOL_PURPOSE_FIELD,
  resolveOS,
} from "../src/kiro-defaults";

// Covers the captured Kiro CLI identity defaults (src/kiro-defaults.ts).
// These values are part of the request-fidelity contract: they must match
// real Kiro CLI traffic, so the tests pin the exact shapes a capture would
// show. A drift here makes pi-kiro's requests distinguishable from the
// official client.

describe("kiro-defaults", () => {
  describe("SYSTEM_SEED_INSTRUCTION", () => {
    it("opens with the captured 'Follow this instruction' preamble", () => {
      expect(SYSTEM_SEED_INSTRUCTION.startsWith("Follow this instruction:")).toBe(true);
    });

    it("carries a {{modelId}} placeholder for runtime substitution", () => {
      expect(SYSTEM_SEED_INSTRUCTION).toContain("{{modelId}}");
    });

    it("identifies as the Kiro CLI default agent", () => {
      expect(SYSTEM_SEED_INSTRUCTION).toContain("Kiro CLI");
    });
  });

  describe("SYSTEM_SEED_ACK", () => {
    it("is the assistant acknowledgement half of the seed pair", () => {
      expect(SYSTEM_SEED_ACK).toContain("incorporate this information");
      expect(SYSTEM_SEED_ACK).not.toContain("{{modelId}}");
    });
  });

  describe("TOOL_PURPOSE_FIELD", () => {
    it("is a string property with the captured description", () => {
      expect(TOOL_PURPOSE_FIELD).toEqual({
        type: "string",
        description: "A brief explanation why you are making this tool use.",
      });
    });
  });

  describe("resolveOS", () => {
    it("maps the current platform to a Kiro operatingSystem value", () => {
      const expected: Record<string, string> = {
        darwin: "macos",
        win32: "windows",
      };
      const got = resolveOS();
      expect(got).toBe(expected[process.platform] ?? process.platform);
    });

    it("returns a non-empty string on every platform", () => {
      expect(resolveOS().length).toBeGreaterThan(0);
    });
  });

  describe("COMPACTION_THRESHOLD_PCT", () => {
    it("is a sane percentage that trips before a hard 413", () => {
      expect(COMPACTION_THRESHOLD_PCT).toBeGreaterThan(0);
      expect(COMPACTION_THRESHOLD_PCT).toBeLessThanOrEqual(100);
      // Captured behavior: force overflow at 95% so compaction runs
      // before the server rejects an oversized request.
      expect(COMPACTION_THRESHOLD_PCT).toBe(95);
    });
  });
});
