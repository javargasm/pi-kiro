import { afterEach, describe, expect, it, vi } from "vitest";

const { readModelDiskCache } = vi.hoisted(() => ({ readModelDiskCache: vi.fn() }));

vi.mock("../src/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models")>()),
  readModelDiskCache,
}));

import registerExtension from "../src/extension";
import { resolveKiroModel, setCachedDynamicModels, type KiroModelDef } from "../src/models";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => {
      if (typeof path === "string" && path.includes("auth.json")) {
        return false;
      }
      return actual.existsSync(path);
    },
  };
});

afterEach(() => {
  readModelDiskCache.mockReset();
  setCachedDynamicModels(null);
});

describe("extension registration", () => {
  it("calls pi.registerProvider with 'kiro' and all documented fields", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];

    await registerExtension(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    const [name, config] = registerProvider.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("kiro");
    expect(config.baseUrl).toBe("https://runtime.us-east-1.kiro.dev");
    expect(config.api).toBe("kiro-api");
    expect(Array.isArray(config.models)).toBe(true);
    expect((config.models as unknown[]).length).toBeGreaterThan(0);
    expect(typeof config.streamSimple).toBe("function");

    const oauth = config.oauth as Record<string, unknown>;
    expect(oauth.name).toBe("Kiro (Builder ID / IAM Identity Center)");
    expect(typeof oauth.login).toBe("function");
    expect(typeof oauth.refreshToken).toBe("function");
    expect(typeof oauth.getApiKey).toBe("function");
    expect(typeof oauth.modifyModels).toBe("function");
  });

  it("retains Auto when a legacy dynamic model cache lacks it", async () => {
    const legacyModels: KiroModelDef[] = [{
      id: "legacy-model",
      name: "Legacy model",
      reasoning: false,
      input: ["text"],
      contextWindow: 8_192,
      maxTokens: 1_024,
    }];
    readModelDiskCache.mockReturnValue(legacyModels);
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];

    await registerExtension(pi);

    const config = registerProvider.mock.calls[0]?.[1] as {
      models: Array<{ id: string }>;
      oauth: { modifyModels: (models: unknown[], cred: Record<string, unknown>) => Array<{ id: string; provider?: string }> };
    };
    expect(config.models.map((model) => model.id)).toEqual(["legacy-model", "auto"]);

    const scoped = config.oauth.modifyModels(config.models, {
      refresh: "r",
      access: "a",
      expires: 0,
      region: "us-east-1",
    });
    expect(scoped.filter((model) => model.provider === "kiro").map((model) => model.id)).toEqual([
      "legacy-model",
      "auto",
    ]);
  });

  // Conformance #2 regression: a model that exists only in the disk cache
  // (fresh cache → no API fetch) used to fail with "Unknown Kiro model ID".
  it("models loaded from the disk cache resolve to Kiro IDs", async () => {
    readModelDiskCache.mockReturnValue([{
      id: "claude-sonnet-9-9",
      name: "Claude Sonnet 9.9",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    }]);
    const pi = {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];

    await registerExtension(pi);

    expect(resolveKiroModel("claude-sonnet-9-9")).toBe("claude-sonnet-9.9");
  });

  it("config uses only documented ProviderConfig fields (no undocumented extensions)", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];
    await registerExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const allowedKeys = new Set([
      "baseUrl",
      "apiKey",
      "api",
      "streamSimple",
      "headers",
      "authHeader",
      "models",
      "oauth",
    ]);
    for (const key of Object.keys(config)) {
      expect(allowedKeys.has(key), `Unexpected ProviderConfig key: ${key}`).toBe(true);
    }

    const oauth = config.oauth as Record<string, unknown>;
    const allowedOAuthKeys = new Set(["name", "login", "refreshToken", "getApiKey", "modifyModels"]);
    for (const key of Object.keys(oauth)) {
      expect(allowedOAuthKeys.has(key), `Unexpected oauth key: ${key}`).toBe(true);
    }
  });

  it("getApiKey returns credentials.access", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];
    await registerExtension(pi);
    const oauth = registerProvider.mock.calls[0]?.[1]?.oauth as {
      getApiKey: (c: Record<string, unknown>) => string;
    };
    expect(oauth.getApiKey({ access: "TOKEN", refresh: "R", expires: 0 })).toBe("TOKEN");
  });

  it("modifyModels scopes Kiro models to apiRegion and rewrites baseUrl", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];
    await registerExtension(pi);

    const oauth = registerProvider.mock.calls[0]?.[1]?.oauth as {
      modifyModels: (models: unknown[], cred: Record<string, unknown>) => unknown[];
    };
    const models = registerProvider.mock.calls[0]?.[1]?.models as Array<{
      id: string;
      provider: string;
    }>;

    const scoped = oauth.modifyModels(models, {
      refresh: "r",
      access: "a",
      expires: 0,
      region: "eu-west-1",
    }) as Array<{ id: string; baseUrl: string; provider: string }>;

    expect(scoped.length).toBeGreaterThan(0);
    for (const m of scoped) {
      if (m.provider === "kiro") {
        expect(m.baseUrl).toBe(
          "https://runtime.eu-central-1.kiro.dev",
        );
      }
    }
  });
});
