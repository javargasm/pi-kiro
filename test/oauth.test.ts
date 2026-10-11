import type { OAuthAuthInfo, OAuthLoginCallbacks, OAuthPrompt, OAuthSelectPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `existsSync` is non-configurable in native ESM, so we mock `node:fs` at
// the top level. The cascade tests in `refreshKiroToken` rely on the Kiro
// IDE credential fallback paths (SQLite DB + AWS SSO cache) returning null;
// the latter would otherwise pick up the developer's real SSO cache file.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(""),
  };
});

// Device-code polling sleeps via node:timers/promises, which fake timers
// don't cover — resolve immediately so polling tests don't wait real seconds.
vi.mock("node:timers/promises", () => ({ setTimeout: () => Promise.resolve() }));

import { loginKiro, refreshKiroToken } from "../src/oauth";
import { existsSync, readFileSync } from "node:fs";

type FetchMock = ReturnType<typeof vi.fn>;

function okJson(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}
function fail(status: number) {
  return { ok: false, status, text: () => Promise.resolve(`error ${status}`) };
}

/**
 * Create callbacks that auto-select a method via onSelect,
 * then feed prompt answers in order via onPrompt.
 */
function makeCallbacks(
  selectId: string,
  promptAnswers: string[] = [],
): OAuthLoginCallbacks {
  const promptQueue = [...promptAnswers];
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onSelect: vi.fn(async (_p: OAuthSelectPrompt) => selectId),
    onPrompt: vi.fn(async (_p: OAuthPrompt) => promptQueue.shift() ?? ""),
    onProgress: vi.fn(),
  };
}

// Builder ID device-code test removed — builder-id now uses social sign-in.
// Device-code flow is only used for IdC. See "loginKiro — Builder ID (social sign-in)" below.

describe("loginKiro — Builder ID (social sign-in)", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("selects Builder ID → social sign-in with PKCE, returns profileArn", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/oauth/token")) {
        return okJson({ accessToken: "AT", refreshToken: "RT", profileArn: "arn:xxx", expiresIn: 3600 });
      }
      if (typeof url === "string" && url.includes("ListAvailableModels")) {
        return okJson({ models: [] });
      }
      return undefined;
    });

    const onAuth = vi.fn((info: OAuthAuthInfo) => {
      const signInUrl = new URL(info.url);
      const state = signInUrl.searchParams.get("state")!;
      // Simulate Kiro's real redirect: adds /oauth/callback path and login_option
      void originalFetch(
        `http://localhost:49153/oauth/callback?code=AUTH_CODE&state=${state}&login_option=google`,
      ).catch(() => {});
    });

    const callbacks: OAuthLoginCallbacks = {
      onAuth,
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(async () => "builder-id"),
      onPrompt: vi.fn(async () => ""),
      onProgress: vi.fn(),
    };

    const creds = await loginKiro(callbacks);

    expect(creds.authMethod).toBe("social");
    expect(creds.access).toBe("AT");
    expect(creds.profileArn).toBe("arn:xxx");
    expect(creds.refresh).toBe("RT|||social");
    expect(creds.region).toBe("us-east-1");
    expect(creds.clientId).toBe("");
    expect(creds.clientSecret).toBe("");

    // Verify sign-in URL structure
    expect(onAuth).toHaveBeenCalledOnce();
    const signInUrl = new URL(onAuth.mock.calls[0]![0].url);
    expect(signInUrl.origin).toBe("https://app.kiro.dev");
    expect(signInUrl.pathname).toBe("/signin");
    expect(signInUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(signInUrl.searchParams.get("redirect_uri")).toBe("http://localhost:49153");
    expect(signInUrl.searchParams.get("redirect_from")).toBe("kirocli");
    expect(signInUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(signInUrl.searchParams.get("state")).toBeTruthy();

    // Verify token exchange payload
    const tokenCallIndex = fetchMock.mock.calls.findIndex(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/oauth/token"),
    );
    expect(tokenCallIndex).toBeGreaterThanOrEqual(0);
    const tokenBody = JSON.parse(fetchMock.mock.calls[tokenCallIndex]![1]?.body as string);
    expect(tokenBody.code).toBe("AUTH_CODE");
    expect(tokenBody.code_verifier).toBeTruthy();
    expect(tokenBody.redirect_uri).toBe("http://localhost:49153/oauth/callback?login_option=google");
  });
});

describe("loginKiro — IdC", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("ListAvailableModels")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [] }),
        });
      }
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("IdC start URL + explicit region skips region probing", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" }))
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://v",
          verificationUriComplete: "https://v",
          userCode: "X",
          deviceCode: "D",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    // onSelect → "idc", then onPrompt → URL, region
    const callbacks = makeCallbacks("idc", [
      "https://mycompany.awsapps.com/start",
      "eu-west-1",
    ]);
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    const creds = await promise;

    expect(creds.region).toBe("eu-west-1");
    const firstUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstUrl).toContain("oidc.eu-west-1.amazonaws.com");
    const devBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(devBody.startUrl).toBe("https://mycompany.awsapps.com/start");
  });

  it("URL alone auto-detects region by probing", async () => {
    vi.useFakeTimers();
    // us-east-1 register fails, eu-west-1 succeeds.
    fetchMock
      .mockResolvedValueOnce(fail(400)) // register us-east-1
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" })) // register eu-west-1
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://v",
          verificationUriComplete: "https://v",
          userCode: "X",
          deviceCode: "D",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    // onPrompt answers: URL, then blank region (auto-detect)
    const callbacks = makeCallbacks("idc", [
      "https://mycompany.awsapps.com/start",
      "",
    ]);
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    const creds = await promise;

    expect(creds.region).toBe("eu-west-1");
  });

  it("rejects non-URL input for IdC start URL", async () => {
    const callbacks = makeCallbacks("idc", ["notaurl"]);
    await expect(loginKiro(callbacks)).rejects.toThrow(/Invalid start URL/);
  });

  it("throws if no region accepts the start URL", async () => {
    // Every probed region fails registration.
    fetchMock.mockResolvedValue(fail(400));
    const callbacks = makeCallbacks("idc", [
      "https://bogus.awsapps.com/start",
      "us-east-1",
    ]);
    await expect(loginKiro(callbacks)).rejects.toThrow(/Could not authorize/);
  });

  it("surfaces onAuth with verificationUriComplete and userCode", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" }))
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://v",
          verificationUriComplete: "https://v?user_code=HELLO",
          userCode: "HELLO",
          deviceCode: "D",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    const onAuth = vi.fn();
    const callbacks: OAuthLoginCallbacks = {
      onAuth,
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(async () => "idc"),
      onPrompt: vi
        .fn()
        .mockResolvedValueOnce("https://x.awsapps.com/start")
        .mockResolvedValueOnce("us-east-1"),
      onProgress: vi.fn(),
    };
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    await promise;

    expect(onAuth).toHaveBeenCalledOnce();
    const info = onAuth.mock.calls[0]?.[0] as OAuthAuthInfo;
    expect(info.url).toBe("https://v?user_code=HELLO");
    expect(info.instructions).toContain("HELLO");
    expect(info.instructions).toContain("10 minutes");
  });

  it("propagates cancel when onSelect returns undefined", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(async () => undefined),
      onPrompt: vi.fn(),
      onProgress: vi.fn(),
    };
    await expect(loginKiro(callbacks)).rejects.toThrow("Login cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates cancel when onPrompt rejects at the region prompt", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onSelect: vi.fn(async () => "idc"),
      onPrompt: vi
        .fn()
        .mockResolvedValueOnce("https://x.awsapps.com/start")
        .mockRejectedValueOnce(new Error("Login cancelled")),
      onProgress: vi.fn(),
    };
    await expect(loginKiro(callbacks)).rejects.toThrow("Login cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshKiroToken", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("ListAvailableModels")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [] }),
        });
      }
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("layer 1 succeeds: refreshes using pipe-packed credentials at the stored region", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );
    const refreshed = await refreshKiroToken({
      refresh: "RT|CID|SEC|idc",
      access: "old",
      expires: 0,
      region: "eu-west-1",
    });
    expect(refreshed.access).toBe("AT2");
    expect(refreshed.refresh).toBe("RT2|CID|SEC|idc");
    expect(refreshed.region).toBe("eu-west-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oidc.eu-west-1.amazonaws.com/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientId: "CID",
          clientSecret: "SEC",
          refreshToken: "RT",
          grantType: "refresh_token",
        }),
      }),
    );
  });

  it("cascade exhausts all layers and throws when region is missing", async () => {
    // All layers will fail — layer 1 fails on missing region, kiro-cli layers
    // return null (no DB file in test env).
    await expect(
      refreshKiroToken({ refresh: "RT|CID|SEC|idc", access: "x", expires: 0 }),
    ).rejects.toThrow(/cascade layers exhausted/);
  });

  it("cascade exhausts all layers and throws on HTTP failure with no CLI fallback", async () => {
    fetchMock.mockResolvedValueOnce(fail(401));
    await expect(
      refreshKiroToken({
        refresh: "RT|CID|SEC|idc",
        access: "x",
        expires: 0,
        region: "us-east-1",
      }),
    ).rejects.toThrow(/cascade layers exhausted/);
  });

  it("error message includes all layer failure reasons", async () => {
    fetchMock.mockResolvedValueOnce(fail(500));
    try {
      await refreshKiroToken({
        refresh: "RT|CID|SEC|idc",
        access: "x",
        expires: 0,
        region: "us-east-1",
      });
      // Should not reach here
      expect.unreachable("Expected refreshKiroToken to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("L1(normal)");
      expect(msg).toContain("cascade layers exhausted");
    }
  });

  it("preserves authMethod through the cascade", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );
    const refreshed = await refreshKiroToken({
      refresh: "RT|CID|SEC|builder-id",
      access: "old",
      expires: 0,
      region: "us-east-1",
      authMethod: "builder-id",
    } as any);
    expect(refreshed.authMethod).toBe("builder-id");
  });

  it("desktop authMethod uses the desktop endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );
    const refreshed = await refreshKiroToken({
      refresh: "RT|||desktop",
      access: "old",
      expires: 0,
      region: "us-east-1",
      authMethod: "desktop",
    } as any);
    expect(refreshed.authMethod).toBe("desktop");
    expect(refreshed.access).toBe("AT2");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("social authMethod uses the desktop endpoint and preserves authMethod", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );
    const refreshed = await refreshKiroToken({
      refresh: "RT|||social",
      access: "old",
      expires: 0,
      region: "us-east-1",
      authMethod: "social",
    } as any);
    expect(refreshed.authMethod).toBe("social");
    expect(refreshed.access).toBe("AT2");
    expect(refreshed.refresh).toBe("RT2|||social");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not sync desktop/IDE refresh tokens back to the kiro-cli DB", async () => {
    vi.mocked(existsSync).mockClear();
    vi.mocked(readFileSync).mockClear();
    vi.mocked(existsSync).mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );

    await refreshKiroToken({
      refresh: "RT|||desktop",
      access: "old",
      expires: 0,
      region: "us-east-1",
      authMethod: "desktop",
      kiroSyncSource: "kiro-sso-cache",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(existsSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("refreshes an imported refresh-only credential once, then gives up", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const cachePath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");

    vi.mocked(existsSync).mockImplementation((p) => p === cachePath);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        refreshToken: "IMPORTED_RT",
        authMethod: "IdC",
        region: "eu-central-1",
      }),
    );
    fetchMock
      .mockResolvedValueOnce(fail(401))
      .mockResolvedValueOnce(fail(401));

    await expect(
      refreshKiroToken({
        refresh: "OLD_RT|CID|SEC|idc",
        access: "old",
        expires: 0,
        region: "eu-central-1",
        authMethod: "idc",
      } as any),
    ).rejects.toThrow(/all 3 cascade layers exhausted/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oidc.eu-central-1.amazonaws.com/token");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken",
    );
  });

  it("loginCliSync falls back to SSO cache when SQLite DB is absent, returns aligned desktop credentials", async () => {
    // Repro of the user-reported flow: ~/.kiro/db missing, but
    // ~/.aws/sso/cache/kiro-auth-token.json present with IdC tokens and
    // no OIDC clientId. loginCliSync must NOT throw "Make sure Kiro IDE
    // is installed", and the returned credential must have aligned
    // struct/pack authMethod so the next refresh hits the desktop
    // endpoint.
    const { existsSync, readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const cachePath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");

    vi.mocked(existsSync).mockImplementation((p) => p === cachePath);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        accessToken: "AT",
        refreshToken: "RT",
        authMethod: "IdC",
        region: "eu-central-1",
      }),
    );

    // loginCliSync also calls fetchAvailableModels after import; stub it.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    } as any);

    const callbacks = makeCallbacks("sync");
    const creds = await loginKiro(callbacks);

    // Struct fields
    expect(creds.access).toBe("AT");
    expect(creds.region).toBe("eu-central-1");
    expect(creds.authMethod).toBe("desktop"); // forced — no OIDC creds
    expect(creds.clientId).toBe("");
    expect(creds.clientSecret).toBe("");

    // Pack suffix must match the struct authMethod (no mismatch that
    // would fail the "missing clientId/clientSecret" precheck on refresh).
    const packAuth = creds.refresh.split("|")[3];
    expect(packAuth).toBe("desktop");
  });

  it("loginCliSync throws the documented error only when BOTH DB and SSO cache are absent", async () => {
    // Neither file present — this is the only path that should still
    // surface the existing "Make sure Kiro IDE is installed" message.
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue("");
    const callbacks = makeCallbacks("sync");
    await expect(loginKiro(callbacks)).rejects.toThrow(
      /Make sure Kiro IDE is installed/,
    );
  });

  it("SSO cache import (no OIDC clientId) is refreshable via the desktop endpoint", async () => {
    // The AWS SSO cache file at ~/.aws/sso/cache/kiro-auth-token.json
    // provides the bearer + refresh tokens but no OIDC clientId/secret.
    // kiroCredsFromCliImport must produce a credential whose struct
    // `authMethod` is "desktop" so the next refresh hits the desktop
    // endpoint instead of failing the OIDC precheck.
    const { importFromKiroSsoCache } = await import("../src/kiro-cli-sync");
    const { readFileSync, existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const cachePath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");

    vi.mocked(existsSync).mockImplementation((p) => p === cachePath);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        accessToken: "AT",
        refreshToken: "RT",
        authMethod: "IdC",
        region: "eu-central-1",
      }),
    );

    const imported = await importFromKiroSsoCache();
    expect(imported).not.toBeNull();

    // Now exercise the refresh path: import succeeded but the struct
    // `authMethod` must be "desktop" so refreshTokenInner uses the
    // desktop endpoint, not the OIDC one (which would fail with
    // "missing clientId/clientSecret").
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );
    const refreshed = await refreshKiroToken({
      refresh: `RT|||desktop`,
      access: "AT",
      expires: 0,
      region: "eu-central-1",
      authMethod: "desktop",
      clientId: "",
      clientSecret: "",
    });
    expect(refreshed.access).toBe("AT2");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
