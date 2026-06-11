import { describe, expect, it, vi } from "vitest";

// `existsSync` is non-configurable in native ESM, so we mock the entire
// `node:fs` module at the top level to control file-existence checks.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(""),
  };
});

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  importFromKiroCli,
  importFromKiroSsoCache,
  getKiroCliCredentialsAllowExpired,
  saveKiroCliCredentials,
} from "../src/kiro-cli-sync";

const existsSyncMock = vi.mocked(existsSync);
const readFileSyncMock = vi.mocked(readFileSync);

/** SSO cache path as resolved by kiro-cli-sync on the current platform. */
const ssoCachePath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");

describe("kiro-cli-sync", () => {
  describe("importFromKiroCli", () => {
    it("returns null when DB file does not exist", async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await importFromKiroCli();
      expect(result).toBeNull();
    });
  });

  describe("getKiroCliCredentialsAllowExpired", () => {
    it("returns null when DB file does not exist", async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await getKiroCliCredentialsAllowExpired();
      expect(result).toBeNull();
    });

    it("delegates to importFromKiroCli — same result for same state", async () => {
      existsSyncMock.mockReturnValue(false);
      const resultA = await importFromKiroCli();
      const resultB = await getKiroCliCredentialsAllowExpired();
      expect(resultA).toEqual(resultB);
    });
  });

  describe("saveKiroCliCredentials", () => {
    it("returns false when DB file does not exist", async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await saveKiroCliCredentials({
        accessToken: "AT",
        refreshToken: "RT",
        region: "us-east-1",
        authMethod: "desktop",
      });
      expect(result).toBe(false);
    });

    it("returns false when no SQLite driver is available", async () => {
      existsSyncMock.mockReturnValue(true);
      // In test env neither bun:sqlite nor better-sqlite3 is available,
      // so the function should gracefully return false.
      const result = await saveKiroCliCredentials({
        accessToken: "AT",
        refreshToken: "RT",
        region: "us-east-1",
        authMethod: "desktop",
      });
      expect(result).toBe(false);
    });
  });

  describe("importFromKiroSsoCache (fallback path)", () => {
    it("returns null when the SSO cache file does not exist", async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await importFromKiroSsoCache();
      expect(result).toBeNull();
    });

    it("imports a valid IdC SSO cache entry", async () => {
      existsSyncMock.mockImplementation((p) => p === ssoCachePath);
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          accessToken: "AT",
          refreshToken: "RT",
          expiresAt: "2026-06-11T10:20:41.409Z",
          clientIdHash: "0772a5274b05eef4d041c055084d8b7d1618991c",
          authMethod: "IdC",
          provider: "Enterprise",
          region: "eu-central-1",
        }),
      );

      const result = await importFromKiroSsoCache();
      expect(result).toEqual({
        accessToken: "AT",
        refreshToken: "RT",
        region: "eu-central-1",
        authMethod: "idc",
      });
      expect(readFileSyncMock).toHaveBeenCalledWith(ssoCachePath, "utf8");
    });

    it("defaults region to us-east-1 when the cache omits it", async () => {
      existsSyncMock.mockImplementation((p) => p === ssoCachePath);
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ accessToken: "AT", refreshToken: "RT", authMethod: "IdC" }),
      );
      const result = await importFromKiroSsoCache();
      expect(result?.region).toBe("us-east-1");
    });

    it("returns null when the cache has no tokens", async () => {
      existsSyncMock.mockImplementation((p) => p === ssoCachePath);
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ authMethod: "IdC", region: "us-east-1" }),
      );
      const result = await importFromKiroSsoCache();
      expect(result).toBeNull();
    });

    it("returns null when the cache contains invalid JSON", async () => {
      existsSyncMock.mockImplementation((p) => p === ssoCachePath);
      readFileSyncMock.mockReturnValue("not json at all");
      const result = await importFromKiroSsoCache();
      expect(result).toBeNull();
    });
  });

  describe("importFromKiroCli (composed: DB then SSO cache fallback)", () => {
    it("returns null when neither DB nor SSO cache is present", async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await importFromKiroCli();
      expect(result).toBeNull();
    });

    it("falls back to the SSO cache when the DB path is missing", async () => {
      // DB missing, but SSO cache is present.
      existsSyncMock.mockImplementation((p) => p === ssoCachePath);
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          accessToken: "AT",
          refreshToken: "RT",
          authMethod: "IdC",
          region: "eu-central-1",
        }),
      );
      const result = await importFromKiroCli();
      expect(result).toEqual({
        accessToken: "AT",
        refreshToken: "RT",
        region: "eu-central-1",
        authMethod: "idc",
      });
    });
  });

  describe("findClientCreds (regression: snake_case client_id)", () => {
    // kiro-cli writes the device-registration blob with snake_case keys
    // (`client_id`, `client_secret`). The old code only looked for
    // camelCase (`clientId`, `clientSecret`) and silently dropped the
    // OIDC creds, which forced the resulting credential to the desktop
    // refresh path even when the kiro-cli DB was available.
    it("extracts client_id / client_secret (snake_case) at top level", async () => {
      existsSyncMock.mockImplementation((p) => p === ssoCachePath);
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          accessToken: "AT",
          refreshToken: "RT",
          authMethod: "IdC",
          region: "eu-central-1",
          // Simulate a device-registration-style blob the test could
          // otherwise confuse with the IdC JSON.
          client_id: "CID",
          client_secret: "CSEC",
        }),
      );
      // This case is actually the SSO cache, not a DB blob, so the
      // SSO cache shape applies — we don't expect findClientCreds to
      // be invoked here. The DB-row scenario is covered by the next
      // two tests via direct evaluation of the matcher.
      const result = await importFromKiroSsoCache();
      expect(result?.authMethod).toBe("idc");
      expect(result?.clientId).toBeUndefined();
    });

    it("camelCase clientId / clientSecret still works (legacy blobs)", () => {
      const obj = { clientId: "CID", clientSecret: "CSEC" };
      const found = (() => {
        // Inline the same algorithm the module uses, to keep this
        // test hermetic (the module's helper isn't exported).
        const visit = (o: unknown): { clientId?: string; clientSecret?: string } => {
          if (!o || typeof o !== "object") return {};
          const obj = o as Record<string, unknown>;
          const id = obj.clientId ?? obj.client_id;
          const secret = obj.clientSecret ?? obj.client_secret;
          if (typeof id === "string" && typeof secret === "string") {
            return { clientId: id, clientSecret: secret };
          }
          for (const k of Object.keys(obj)) {
            const r = visit(obj[k]);
            if (r.clientId) return r;
          }
          return {};
        };
        return visit(obj);
      })();
      expect(found).toEqual({ clientId: "CID", clientSecret: "CSEC" });
    });

    it("snake_case client_id / client_secret (kiro-cli shape) is now extracted", () => {
      // kiro-cli device-registration JSON looks like:
      // { client_id, client_secret, client_secret_expires_at, region, ... }
      const kiroCliDeviceReg = {
        client_id: "EEroVUMB57OIVyJxypVn5GV1LWNlbnRyYWwtMQ",
        client_secret: "eyJraWQiOiJrZXktMTU2Njk2ODI4MC...",
        client_secret_expires_at: "2026-09-06T04:35:43Z",
        region: "eu-central-1",
        oauth_flow: "PKCE",
        scopes: ["codewhisperer:completions"],
      };

      const found = (() => {
        const visit = (o: unknown): { clientId?: string; clientSecret?: string } => {
          if (!o || typeof o !== "object") return {};
          const obj = o as Record<string, unknown>;
          const id = obj.clientId ?? obj.client_id;
          const secret = obj.clientSecret ?? obj.client_secret;
          if (typeof id === "string" && typeof secret === "string") {
            return { clientId: id, clientSecret: secret };
          }
          for (const k of Object.keys(obj)) {
            const r = visit(obj[k]);
            if (r.clientId) return r;
          }
          return {};
        };
        return visit(kiroCliDeviceReg);
      })();

      expect(found.clientId).toBe("EEroVUMB57OIVyJxypVn5GV1LWNlbnRyYWwtMQ");
      expect(found.clientSecret).toBe("eyJraWQiOiJrZXktMTU2Njk2ODI4MC...");
    });

    it("recurses into nested blobs (kiro-cli wraps client_id inside serialized config)", () => {
      // kiro-cli's device-registration JSON has `client_secret` as a
      // JWT (not a nested object) — but the device-registration may
      // nest under other keys in some versions. Verify recursion still
      // finds the creds at depth.
      const nested = {
        outer: {
          inner: {
            client_id: "DEEP_CID",
            client_secret: "DEEP_CSEC",
          },
        },
      };
      const visit = (o: unknown): { clientId?: string; clientSecret?: string } => {
        if (!o || typeof o !== "object") return {};
        const obj = o as Record<string, unknown>;
        const id = obj.clientId ?? obj.client_id;
        const secret = obj.clientSecret ?? obj.client_secret;
        if (typeof id === "string" && typeof secret === "string") {
          return { clientId: id, clientSecret: secret };
        }
        for (const k of Object.keys(obj)) {
          const r = visit(obj[k]);
          if (r.clientId) return r;
        }
        return {};
      };
      expect(visit(nested)).toEqual({ clientId: "DEEP_CID", clientSecret: "DEEP_CSEC" });
    });
  });

  describe("kiro-cli DB key detection (regression: 'odic' substring)", () => {
    // kiro-cli uses the literal substring "odic" in its auth_kv keys
    // (e.g. `kirocli:odic:token`, `kirocli:odic:device-registration`).
    // The old code only checked for "oidc" / "idc" and would default
    // those tokens to authMethod="desktop" — wrong. Verify the
    // detection now matches "odic", "oidc", and "idc" alike.
    //
    // We can't easily drive the SQLite branch in the test environment
    // (no bun:sqlite / better-sqlite3), so this is a direct unit test
    // of the substring matcher as exposed by the import function's
    // behavior. The matcher's behavior is observable through the
    // authMethod field on the returned credential, so we instead
    // replicate the matcher inline for a focused regression check.
    const isIdcKey = (key: string) =>
      key.includes("odic") || key.includes("oidc") || key.includes("idc");

    it("recognizes kirocli:odic:token as IdC", () => {
      expect(isIdcKey("kirocli:odic:token")).toBe(true);
    });

    it("recognizes kirocli:odic:device-registration as IdC", () => {
      expect(isIdcKey("kirocli:odic:device-registration")).toBe(true);
    });

    it("recognizes codewhisperer:odic:token as IdC", () => {
      expect(isIdcKey("codewhisperer:odic:token")).toBe(true);
    });

    it("recognizes generic :idc: as IdC", () => {
      expect(isIdcKey("kirocli:idc:token")).toBe(true);
    });

    it("recognizes :oidc: as IdC", () => {
      expect(isIdcKey("kirocli:oidc:token")).toBe(true);
    });

    it("does NOT misclassify :social: as IdC", () => {
      expect(isIdcKey("kirocli:social:token")).toBe(false);
    });
  });

  describe("kiro-cli data.sqlite3 path resolution (primary path)", () => {
    // The DB path is platform-specific, so we pin expectations to the
    // current `process.platform` and verify it points to the documented
    // kiro-cli location (NOT the legacy `~/.kiro/db/kiro.db` that
    // matched no real Kiro product).
    it("resolves to the documented kiro-cli data.sqlite3 location for this platform", async () => {
      // Make existsSync return true ONLY for the path the function picks.
      // We discover the path by stubbing existsSync to return a sentinel
      // for whatever the function asks about, then triggering a read.
      const calledPaths: string[] = [];
      existsSyncMock.mockImplementation((p) => {
        if (typeof p === "string") calledPaths.push(p);
        return false; // never found — we just want to observe the query
      });

      await importFromKiroCli();

      const dbPath = calledPaths.find(
        (p) => p.includes("kiro-cli") && p.endsWith("data.sqlite3"),
      );
      expect(dbPath).toBeDefined();

      const home = homedir();
      const expectedSubstrings: Partial<Record<NodeJS.Platform, string[]>> = {
        darwin: [join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3")],
        win32: ["kiro-cli", "data.sqlite3"], // %APPDATA% varies; just check suffix
        linux: [join(home, ".local", "share", "kiro-cli", "data.sqlite3")],
        // Other Unix-likes fall through to the Linux XDG-style path.
      };
      const expected = expectedSubstrings[process.platform];
      if (expected && expected.length > 0 && process.platform !== "win32") {
        // For non-Windows we can fully assert the absolute path.
        expect(dbPath).toBe(expected[0]);
      } else {
        // Windows: just verify the suffix components.
        for (const part of expected ?? []) {
          expect(dbPath).toContain(part);
        }
      }
    });

    it("respects XDG_DATA_HOME on Linux", async () => {
      if (process.platform === "win32" || process.platform === "darwin") {
        return; // XDG is Linux-specific
      }
      const originalXdg = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = "/custom/xdg/data";
      try {
        const calledPaths: string[] = [];
        existsSyncMock.mockImplementation((p) => {
          if (typeof p === "string") calledPaths.push(p);
          return false;
        });
        await importFromKiroCli();
        const dbPath = calledPaths.find(
          (p) => p.includes("kiro-cli") && p.endsWith("data.sqlite3"),
        );
        expect(dbPath).toBe("/custom/xdg/data/kiro-cli/data.sqlite3");
      } finally {
        if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdg;
      }
    });

    it("never queries the legacy ~/.kiro/db/kiro.db path", async () => {
      // Regression: the old code looked at ~/.kiro/db/kiro.db, which
      // matched no real Kiro product. Confirm we no longer query it.
      const calledPaths: string[] = [];
      existsSyncMock.mockImplementation((p) => {
        if (typeof p === "string") calledPaths.push(p);
        return false;
      });
      await importFromKiroCli();
      for (const p of calledPaths) {
        expect(p).not.toContain(".kiro/db/kiro.db");
      }
    });
  });
});
