import { describe, expect, it } from "vitest";
import {
  filterModelsByRegion,
  KIRO_MODEL_IDS,
  kiroModels,
  resolveApiRegion,
  resolveKiroModel,
} from "../src/models";

describe("resolveKiroModel", () => {
  it("converts dashes between digits to dots", () => {
    expect(resolveKiroModel("claude-sonnet-4-6")).toBe("claude-sonnet-4.6");
    expect(resolveKiroModel("claude-opus-4-7")).toBe("claude-opus-4.7");
    expect(resolveKiroModel("minimax-m2-5")).toBe("minimax-m2.5");
  });

  it("preserves IDs without digit-dash-digit patterns", () => {
    expect(resolveKiroModel("auto")).toBe("auto");
    expect(resolveKiroModel("qwen3-coder-next")).toBe("qwen3-coder-next");
  });

  it("throws on unknown model IDs", () => {
    expect(() => resolveKiroModel("gpt-4")).toThrow(/Unknown Kiro model ID/);
  });

  it("every kiroModels entry resolves to a known Kiro ID", () => {
    for (const m of kiroModels) {
      expect(() => resolveKiroModel(m.id)).not.toThrow();
      expect(KIRO_MODEL_IDS.has(resolveKiroModel(m.id))).toBe(true);
    }
  });
});

describe("resolveApiRegion", () => {
  it("defaults to us-east-1 for undefined", () => {
    expect(resolveApiRegion(undefined)).toBe("us-east-1");
  });

  it("maps EU SSO regions to eu-central-1", () => {
    expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    expect(resolveApiRegion("eu-west-2")).toBe("eu-central-1");
    expect(resolveApiRegion("eu-north-1")).toBe("eu-central-1");
  });

  it("maps US SSO regions to us-east-1", () => {
    expect(resolveApiRegion("us-west-2")).toBe("us-east-1");
    expect(resolveApiRegion("us-east-2")).toBe("us-east-1");
  });

  it("passes through unmapped regions", () => {
    expect(resolveApiRegion("me-south-1")).toBe("me-south-1");
  });
});

describe("filterModelsByRegion", () => {
  it("returns models available in us-east-1", () => {
    const r = filterModelsByRegion(kiroModels, "us-east-1");
    expect(r.length).toBeGreaterThan(0);
    expect(r.find((m) => m.id === "claude-opus-4-7")).toBeDefined();
  });

  it("eu-central-1 is a subset of us-east-1", () => {
    // Historically eu-central-1 carried fewer models than us-east-1, and the
    // difference was exactly the now-removed stale models (1M variants +
    // third-party deepseek/kimi/glm/qwen-480b/agi-nova). After the stale
    // cleanup both regions expose the same mainstream set, so the durable
    // invariant is subset (⊆), not strict-smaller (<).
    const us = filterModelsByRegion(kiroModels, "us-east-1");
    const eu = filterModelsByRegion(kiroModels, "eu-central-1");
    expect(eu.length).toBeGreaterThan(0);
    const usIds = new Set(us.map((m) => m.id));
    for (const m of eu) {
      expect(usIds.has(m.id)).toBe(true);
    }
  });

  it("returns empty for unknown regions", () => {
    const r = filterModelsByRegion(kiroModels, "atlantis-1");
    expect(r).toEqual([]);
  });
});

describe("kiroModels catalog", () => {
  it("every model uses the shared api/provider/baseUrl defaults", () => {
    for (const m of kiroModels) {
      expect(m.api).toBe("kiro-api");
      expect(m.provider).toBe("kiro");
      expect(m.baseUrl).toBe("https://runtime.us-east-1.kiro.dev");
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("has no duplicate IDs", () => {
    const ids = kiroModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("high-effort reasoning models get an extended idle timeout", () => {
    // These models can sit silent (no parsed event) for long stretches
    // while deliberating at high/xhigh effort. A tight idle window trips
    // mid-think; the idle window must be at least as generous as the
    // first-token window for them.
    for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-fable-5"]) {
      const m = kiroModels.find((x) => x.id === id);
      expect(m, `missing model ${id}`).toBeDefined();
      expect(m?.idleTimeout).toBe(180_000);
      expect(m?.idleTimeout ?? 0).toBeGreaterThanOrEqual(m?.firstTokenTimeout ?? 0);
    }
  });
});
