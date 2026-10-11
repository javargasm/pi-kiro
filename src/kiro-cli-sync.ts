// Kiro CLI credential sync — import tokens from local Kiro storage.
//
// Kiro has two products that store credentials locally, and they use
// different formats:
//
//   1. kiro-cli (Rust CLI). Credentials live in a SQLite database at
//      `data.sqlite3` in the platform's standard data directory:
//        - macOS:   ~/Library/Application Support/kiro-cli/data.sqlite3
//        - Linux:   $XDG_DATA_HOME/kiro-cli/data.sqlite3
//                   (or ~/.local/share/kiro-cli/data.sqlite3)
//        - Windows: %APPDATA%/kiro-cli/data.sqlite3
//      The `auth_kv` table holds token rows (keys: `kirocli:odic:token`,
//      `kirocli:social:token`, etc.) and the device-registration row with
//      OIDC clientId/clientSecret. The `state` table holds the active
//      profile ARN under `api.codewhisperer.profile`.
//
//   2. Kiro IDE (VSCode-based GUI). The IDE does NOT use SQLite for
//      auth tokens; it writes the standard AWS SSO OIDC cache JSON to
//      `~/.aws/sso/cache/kiro-auth-token.json` on successful SSO login.
//      This file holds bearer + refresh tokens, expiry, region, and
//      `authMethod: "IdC"`, but NOT the OIDC clientId/secret — those
//      live only in the kiro-cli SQLite DB.
//
// This module reads from the kiro-cli SQLite DB first (preferred: gives
// full OIDC creds), then falls back to the Kiro IDE SSO cache JSON
// (weaker: no OIDC creds, refresh must go through the desktop endpoint).
// SQLite access uses bun:sqlite when running under Bun, otherwise Node's
// built-in node:sqlite (Node >= 22.13 — the usual path, since pi runs
// extensions on Node). Imports open the DB read-only. Refresh write-back is
// limited to credentials that originated from the kiro-cli SQLite DB, and
// updates the exact token row that was imported so desktop/IDE refresh
// tokens are never mixed into CLI token storage.
//
// This enables zero-friction login: if the user has kiro-cli or Kiro
// IDE installed and logged in, pi-kiro can import the credentials
// without the device-code flow.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { log } from "./debug";

export type KiroCredentialSource = "kiro-cli-db" | "kiro-sso-cache";

export interface KiroCliCredentials {
  accessToken: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  region: string;
  profileArn?: string;
  authMethod: "idc" | "desktop";
  email?: string;
  source?: KiroCredentialSource;
  /** Exact `auth_kv.key` for the imported token row, present for DB imports. */
  tokenKey?: string;
}

export interface AuthKvRow {
  key: string;
  value: string;
}

interface KiroDbSnapshot {
  rows: AuthKvRow[];
  activeProfileArn?: string;
}

interface SqliteStatement {
  all(): unknown[];
  get(...params: string[]): unknown;
  run(...params: string[]): unknown;
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  run?(sql: string): unknown;
  exec?(sql: string): unknown;
  close(): void;
}

interface SqliteDatabaseConstructor {
  new (path: string, options?: { readonly?: boolean }): SqliteDb;
}

/**
 * Resolve a SQLite driver: `bun:sqlite` (when running under Bun), then
 * Node's built-in `node:sqlite` (works on a plain Node pi install with zero
 * extra dependencies — the common case, since pi usually runs extensions on
 * Node). Returns null when neither is available. Never throws.
 */
async function loadSqliteDriver(): Promise<SqliteDatabaseConstructor | null> {
  try {
    // @ts-ignore - bun:sqlite is a Bun-only built-in; may not resolve under all TS versions
    return (await import("bun:sqlite")).Database as SqliteDatabaseConstructor;
  } catch {
    // Not running under Bun — fall through.
  }
  try {
    // DatabaseSync already matches SqliteDb; only the constructor differs,
    // taking `readOnly` where bun:sqlite takes `readonly`.
    const { DatabaseSync } = await import("node:sqlite");
    return function (path: string, options?: { readonly?: boolean }) {
      return new DatabaseSync(path, { readOnly: options?.readonly });
    } as unknown as SqliteDatabaseConstructor;
  } catch {
    log.debug("No SQLite driver available (bun:sqlite, node:sqlite)");
    return null;
  }
}

/**
 * Platform-specific path to kiro-cli's SQLite credential database
 * (`data.sqlite3`). The Kiro IDE (GUI) does not use SQLite for auth
 * tokens — it writes the AWS SSO cache JSON instead (see
 * `getKiroSsoCachePath` below). Only kiro-cli (the Rust CLI) stores
 * credentials in a SQLite DB at these locations, confirmed in
 * kirodotdev/Kiro#4847 and the kiro-cli source.
 */
function getKiroDbPath(): string {
  const home = homedir();

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
  }

  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(home, "AppData", "Roaming"),
      "kiro-cli",
      "data.sqlite3",
    );
  }

  // Linux and other Unix-likes: honor XDG_DATA_HOME per the XDG Base
  // Directory spec; fall back to ~/.local/share which is kiro-cli's
  // default when XDG_DATA_HOME is unset.
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData && xdgData.length > 0) {
    return join(xdgData, "kiro-cli", "data.sqlite3");
  }
  return join(home, ".local", "share", "kiro-cli", "data.sqlite3");
}

/**
 * Platform-specific path to Kiro IDE's AWS SSO OIDC cache JSON file.
 * Kiro IDE (the GUI) does not use SQLite for auth tokens; it writes
 * the standard AWS SSO OIDC cache JSON to this path on successful SSO
 * login. Per the AWS SSO OIDC client spec the file lives at
 * `~/.aws/sso/cache/kiro-auth-token.json` on macOS/Linux and
 * `%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json` on Windows.
 */
function getKiroSsoCachePath(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      process.env.USERPROFILE || home,
      ".aws",
      "sso",
      "cache",
      "kiro-auth-token.json",
    );
  }
  return join(home, ".aws", "sso", "cache", "kiro-auth-token.json");
}

/** Safely parse JSON, returning null on failure. */
function safeJsonParse(value: unknown): any {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Recursively search a nested object for the OIDC clientId + clientSecret.
 * kiro-cli writes these as `client_id` / `client_secret` (snake_case) in
 * its device-registration blob; some legacy codewhisperer / Kiro IDE
 * blobs use camelCase (`clientId` / `clientSecret`). Accept either
 * casing, nested at any depth.
 */
function findClientCreds(obj: any): { clientId?: string; clientSecret?: string } {
  if (!obj || typeof obj !== "object") return {};
  const id = obj.clientId ?? obj.client_id;
  const secret = obj.clientSecret ?? obj.client_secret;
  if (typeof id === "string" && typeof secret === "string") {
    return { clientId: id, clientSecret: secret };
  }
  for (const key of Object.keys(obj)) {
    const result = findClientCreds(obj[key]);
    if (result.clientId) return result;
  }
  return {};
}

function isIdcTokenKey(key: string): boolean {
  // kiro-cli uses the literal substring "odic" in its key names
  // (e.g. `kirocli:odic:token`, `kirocli:odic:device-registration`).
  // Some legacy codewhisperer / Kiro IDE blobs use "oidc" (with an
  // extra 'o') or "idc" — accept all three to avoid defaulting real
  // IdC tokens to `desktop`.
  return key.includes("odic") || key.includes("oidc") || key.includes("idc");
}

function isTokenRow(row: AuthKvRow): boolean {
  return row.key.includes(":token");
}

function tokenReadRank(row: AuthKvRow): number {
  return isIdcTokenKey(row.key) ? 0 : 1;
}

export function selectKiroTokenRowForWrite(
  rows: AuthKvRow[],
  creds: Pick<KiroCliCredentials, "authMethod" | "tokenKey">,
): AuthKvRow | undefined {
  return rows.find((row) => row.key === creds.tokenKey && isTokenRow(row));
}

/**
 * Extract region from an ARN string (e.g. arn:aws:codewhisperer:us-east-1:...).
 * Returns undefined if the ARN is malformed.
 */
function extractRegionFromArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return undefined;
  const region = parts[3];
  return region && region.length > 0 ? region : undefined;
}

/**
 * Attempt to read credentials from Kiro IDE's local database.
 *
 * Returns the first valid credential set found, or null if:
 * - Kiro IDE is not installed
 * - The database is unreadable
 * - No valid tokens are stored
 *
 * This function never throws — all errors are caught and logged.
 */
async function importFromKiroDb(): Promise<KiroCliCredentials | null> {
  const dbPath = getKiroDbPath();
  if (!existsSync(dbPath)) {
    log.debug(`Kiro CLI DB not found at ${dbPath}`);
    return null;
  }

  try {
    const Database = await loadSqliteDriver();
    if (!Database) return null;

    const db = new Database(dbPath, { readonly: true });

    // Set busy timeout to avoid SQLITE_BUSY if Kiro IDE has the DB open.
    try {
      db.run?.("PRAGMA busy_timeout = 5000") ?? db.exec?.("PRAGMA busy_timeout = 5000");
    } catch {
      // Some SQLite drivers use exec instead of run
    }

    // Read auth_kv table
    let rows: AuthKvRow[];
    try {
      const stmt = db.prepare("SELECT key, value FROM auth_kv");
      rows = stmt.all() as AuthKvRow[];
    } catch {
      log.debug("Failed to read auth_kv table from Kiro DB");
      try { db.close(); } catch { /* ignore */ }
      return null;
    }

    // Try to read active profile ARN from state table
    let activeProfileArn: string | undefined;
    try {
      const stateStmt = db.prepare("SELECT value FROM state WHERE key = ?");
      const stateRow = stateStmt.get("api.codewhisperer.profile") as
        | { value?: unknown }
        | undefined;
      const parsed = safeJsonParse(stateRow?.value);
      const arn = parsed?.arn || parsed?.profileArn || parsed?.profile_arn;
      if (typeof arn === "string" && arn.trim()) {
        activeProfileArn = arn.trim();
      }
    } catch {
      // State table might not exist — that's fine, tokens still work.
    }

    try { db.close(); } catch { /* ignore */ }

    // Extract device registration credentials (clientId/clientSecret)
    const deviceRegRow = rows.find(
      (r) => typeof r?.key === "string" && r.key.includes("device-registration"),
    );
    const deviceReg = safeJsonParse(deviceRegRow?.value);
    const regCreds = deviceReg ? findClientCreds(deviceReg) : {};

    // Find token entries. Prefer IdC/OIDC CLI rows over social/desktop rows
    // when multiple token families are present.
    const tokenRows = rows.filter(isTokenRow).sort((a, b) => tokenReadRank(a) - tokenReadRank(b));
    for (const row of tokenRows) {

      const data = safeJsonParse(row.value);
      if (!data) continue;

      const accessToken = data.accessToken || data.access_token;
      const refreshToken = data.refreshToken || data.refresh_token;
      if (!accessToken && !refreshToken) continue;

      const isIdc = isIdcTokenKey(row.key);
      const authMethod: "idc" | "desktop" = isIdc ? "idc" : "desktop";

      const oidcRegion = data.region || "us-east-1";
      let profileArn: string | undefined = data.profile_arn || data.profileArn;
      if (!profileArn && isIdc) {
        profileArn = activeProfileArn;
      }
      const serviceRegion = extractRegionFromArn(profileArn) || oidcRegion;

      const result: KiroCliCredentials = {
        accessToken: accessToken || "",
        refreshToken: refreshToken || "",
        region: serviceRegion,
        authMethod,
        profileArn,
        email: data.email || data.emailAddress,
        source: "kiro-cli-db",
        tokenKey: row.key,
      };

      // For IdC accounts, attach clientId/clientSecret from device registration
      if (isIdc && regCreds.clientId) {
        result.clientId = regCreds.clientId;
        result.clientSecret = regCreds.clientSecret;
      }

      log.info(
        `Imported Kiro CLI credentials (method=${authMethod}, region=${serviceRegion}` +
        `${result.email ? `, email=${result.email}` : ""})`,
      );

      return result;
    }

    log.debug("No valid token entries found in Kiro CLI DB");
    return null;
  } catch (err) {
    log.warn(`Failed to import from Kiro CLI: ${err}`);
    return null;
  }
}

/** Subset of the AWS SSO OIDC cache entry shape that Kiro IDE writes. */
interface KiroSsoCacheToken {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  clientIdHash?: unknown;
  authMethod?: unknown;
  provider?: unknown;
  region?: unknown;
}

/**
 * Map the SSO cache's `authMethod` string to our internal KiroCliCredentials
 * shape. Kiro IDE writes `"IdC"` for IAM Identity Center logins. The cache
 * does not record Builder ID — the AWS Builder ID path uses the standard
 * `getCachedToken` and is not present in this file. Unknown / missing
 * values default to `"idc"` because that's the only string observed in
 * the wild.
 */
function mapSsoCacheAuthMethod(value: unknown): "idc" | "desktop" {
  if (typeof value !== "string") return "idc";
  const v = value.toLowerCase();
  if (v === "builderid" || v === "builder-id") return "desktop";
  return "idc";
}

/**
 * Import credentials from Kiro IDE's AWS SSO OIDC cache file.
 *
 * Path: `~/.aws/sso/cache/kiro-auth-token.json` (per the AWS SSO OIDC
 * client spec; AWS CLI and Kiro IDE both write here on successful SSO login).
 *
 * The file contains the bearer access token, refresh token, expiry, region,
 * and the SSO auth method ("IdC", etc.). It does NOT contain the OIDC
 * clientId/clientSecret — those are stored in Kiro IDE's SQLite DB.
 *
 * This is a fallback for when the SQLite read fails (locked, missing,
 * unreadable) or yields no tokens. Without OIDC client creds, refresh must
 * go through the desktop endpoint; we set `authMethod: "desktop"` for that
 * path. The original SSO identity (IdC) is preserved by leaving
 * `region` and the token values intact.
 *
 * Returns null if the file doesn't exist, is unreadable, isn't valid JSON,
 * or has no token fields. Never throws.
 */
export async function importFromKiroSsoCache(): Promise<KiroCliCredentials | null> {
  const path = getKiroSsoCachePath();
  if (!existsSync(path)) {
    log.debug(`Kiro SSO cache not found at ${path}`);
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log.warn(`Failed to read Kiro SSO cache at ${path}: ${err}`);
    return null;
  }

  const token = safeJsonParse(raw) as KiroSsoCacheToken | null;
  if (!token || typeof token !== "object") {
    log.debug(`Kiro SSO cache at ${path} is not valid JSON`);
    return null;
  }

  const accessToken = typeof token.accessToken === "string" ? token.accessToken : "";
  const refreshToken = typeof token.refreshToken === "string" ? token.refreshToken : "";
  if (!accessToken && !refreshToken) {
    log.debug(`Kiro SSO cache at ${path} has no tokens`);
    return null;
  }

  const region =
    typeof token.region === "string" && token.region.length > 0 ? token.region : "us-east-1";
  const authMethod = mapSsoCacheAuthMethod(token.authMethod);

  log.info(
    `Imported Kiro SSO cache credentials (method=${authMethod}, region=${region})`,
  );

  return {
    accessToken,
    refreshToken,
    region,
    authMethod,
    source: "kiro-sso-cache",
  };
}

/**
 * Top-level import: try the Kiro IDE SQLite DB first, then fall back to
 * the AWS SSO cache JSON. The cache is a strictly weaker source (no
 * OIDC clientId/clientSecret) so the SQLite read is preferred.
 *
 * Returns null only when neither path yields valid credentials.
 * Never throws.
 */
export async function importFromKiroCli(): Promise<KiroCliCredentials | null> {
  const dbResult = await importFromKiroDb();
  if (dbResult) return dbResult;
  return importFromKiroSsoCache();
}

/**
 * Write refreshed credentials back to Kiro CLI's local SQLite database.
 *
 * This enables bidirectional sync for credentials originally imported from the
 * DB. The credential must carry `source: "kiro-cli-db"` and the exact imported
 * `auth_kv` token key; unrelated token families are never overwritten.
 *
 * Never throws — all errors are caught and logged. A failed write-back is
 * non-fatal; the refreshed token is still valid in memory.
 */
export async function saveKiroCliCredentials(creds: KiroCliCredentials): Promise<boolean> {
  if (creds.source !== "kiro-cli-db" || !creds.tokenKey) {
    log.debug("Credential write-back skipped: credential did not originate from kiro-cli DB");
    return false;
  }

  const dbPath = getKiroDbPath();
  if (!existsSync(dbPath)) {
    log.debug(`Kiro CLI DB not found at ${dbPath} — cannot save credentials`);
    return false;
  }

  try {
    const Database = await loadSqliteDriver();
    if (!Database) return false;

    // Open in read-write mode (no `readonly` flag).
    const db = new Database(dbPath);

    try {
      db.run?.("PRAGMA busy_timeout = 5000") ?? db.exec?.("PRAGMA busy_timeout = 5000");
    } catch {
      // Some SQLite drivers use exec instead of run
    }

    let rows: AuthKvRow[];
    try {
      const stmt = db.prepare("SELECT key, value FROM auth_kv");
      rows = stmt.all() as AuthKvRow[];
    } catch {
      log.debug("Failed to read auth_kv table for credential write-back");
      try { db.close(); } catch { /* ignore */ }
      return false;
    }

    const tokenRow = selectKiroTokenRowForWrite(rows, creds);
    if (!tokenRow) {
      log.debug("No matching token entry found in auth_kv — cannot write back");
      try { db.close(); } catch { /* ignore */ }
      return false;
    }

    // Parse existing value, merge updated fields, write back.
    const existing = safeJsonParse(tokenRow.value) ?? {};
    const updated = {
      ...existing,
      accessToken: creds.accessToken,
      access_token: creds.accessToken,
      refreshToken: creds.refreshToken,
      refresh_token: creds.refreshToken,
    };

    try {
      const updateStmt = db.prepare("UPDATE auth_kv SET value = ? WHERE key = ?");
      updateStmt.run(JSON.stringify(updated), tokenRow.key);
    } catch (err) {
      log.warn(`Failed to write credentials back to Kiro CLI DB: ${err}`);
      try { db.close(); } catch { /* ignore */ }
      return false;
    }

    try { db.close(); } catch { /* ignore */ }

    log.info("Wrote refreshed credentials back to Kiro CLI DB");
    return true;
  } catch (err) {
    log.warn(`Failed to save credentials to Kiro CLI: ${err}`);
    return false;
  }
}
