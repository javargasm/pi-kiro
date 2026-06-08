import { describe, expect, it, vi } from "vitest";

// `existsSync` is non-configurable in native ESM, so we mock the entire
// `node:fs` module at the top level to control file-existence checks.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

import { existsSync } from "node:fs";
import {
  importFromKiroCli,
  getKiroCliCredentialsAllowExpired,
  saveKiroCliCredentials,
} from "../src/kiro-cli-sync";

const existsSyncMock = vi.mocked(existsSync);

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
});
