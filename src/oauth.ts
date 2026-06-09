// Kiro OAuth — AWS Builder ID and IAM Identity Center (IdC).
//
// Two login methods, selected interactively:
//
//   1. Builder ID — AWS's personal-account SSO. Fixed start URL
//      (https://view.awsapps.com/start), always us-east-1.
//   2. IdC — enterprise SSO. User supplies their company start URL
//      (e.g. https://mycompany.awsapps.com/start); region is auto-detected
//      across common AWS regions, or the user can specify it.
//
// Both methods use the same AWS SSO-OIDC device-code flow and the same
// refresh endpoint. Social login (Google/GitHub) is not supported — it
// requires kiro-cli, which we intentionally don't depend on.
//
// NOTE on mirrored-cursor rendering glitch:
// pi's login-dialog (modes/interactive/components/login-dialog.ts) appends
// `this.input` to `contentContainer` on every `showPrompt` call without
// clearing the container first. The second `onPrompt` call therefore shows
// two visible Input widgets bound to the same buffer — typing in one updates
// both. Our user's input is still captured correctly (both widgets share
// `this.input`). The glitch is cosmetic, upstream, and out of scope for this
// extension to fix. Report upstream: add `this.contentContainer.clear()` at
// the top of `showPrompt`, or allocate a new Input per call.

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { log } from "./debug";
import { isPermanentError } from "./health";
import {
  fetchAvailableModels,
  buildModelsFromApi,
  resolveApiRegion,
  setCachedDynamicModels,
} from "./models";
import type { KiroCliCredentials } from "./kiro-cli-sync";

export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_REGION = "us-east-1";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

/** Regions probed when an IdC user leaves the region blank. */
const IDC_PROBE_REGIONS = [
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "us-east-2",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "us-west-2",
];

/** 5-minute safety buffer subtracted from real token expiry. */
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  /**
   * OIDC client secret from AWS SSO-OIDC client registration.
   *
   * SENSITIVE: persist only in secure storage (e.g. keychain, encrypted
   * file, HTTP-only cookie). Do not log, do not send to telemetry, do not
   * embed in URLs or query strings. Together with `refresh`, it can mint
   * new access tokens for the user's AWS identity.
   */
  clientSecret: string;
  region: string;
  /**
   * Which SSO flow produced this credential.
   * - `builder-id`: AWS Builder ID (personal AWS account, us-east-1).
   * - `idc`: IAM Identity Center (enterprise SSO, any region).
   * - `desktop`: Kiro IDE native install (bare refresh token, no clientId/clientSecret).
   */
  authMethod: "builder-id" | "idc" | "desktop";
}

interface DeviceAuthResponse {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

interface ClientRegisterResponse {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Promise-based delay that rejects promptly if the signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function tryRegisterAndAuthorize(
  startUrl: string,
  region: string,
): Promise<{
  clientId: string;
  clientSecret: string;
  oidcEndpoint: string;
  devAuth: DeviceAuthResponse;
} | null> {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;

  const regResp = await fetch(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({
      clientName: "pi-kiro",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!regResp.ok) return null;
  const { clientId, clientSecret } = (await regResp.json()) as ClientRegisterResponse;

  const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!devResp.ok) return null;

  return {
    clientId,
    clientSecret,
    oidcEndpoint,
    devAuth: (await devResp.json()) as DeviceAuthResponse,
  };
}

async function pollForToken(
  oidcEndpoint: string,
  clientId: string,
  clientSecret: string,
  devAuth: DeviceAuthResponse,
  signal: AbortSignal | undefined,
): Promise<TokenResponse> {
  const deadline = Date.now() + (devAuth.expiresIn || 600) * 1000;
  const baseInterval = (devAuth.interval || 5) * 1000;
  let interval = baseInterval;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await abortableDelay(interval, signal);

    // Any transient failure (network, 5xx, non-JSON body) is treated like
    // `authorization_pending` — we keep polling until the deadline. The OIDC
    // token endpoint occasionally returns HTML error pages under load; those
    // should not abort a still-valid device code.
    let resp: Response;
    try {
      resp = await fetch(`${oidcEndpoint}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode: devAuth.deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch {
      continue;
    }

    // 5xx → transient, keep polling.
    if (resp.status >= 500) continue;

    let data: TokenResponse;
    try {
      data = (await resp.json()) as TokenResponse;
    } catch {
      // Non-JSON body (HTML error page, empty, etc.) — treat as transient
      // unless the status itself is a hard 4xx we can't interpret.
      if (!resp.ok) {
        throw new Error(`Authorization failed: HTTP ${resp.status}`);
      }
      continue;
    }

    if (!data.error && data.accessToken && data.refreshToken) return data;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval += baseInterval;
      continue;
    }
    if (data.error) throw new Error(`Authorization failed: ${data.error}`);
  }
  throw new Error("Authorization timed out");
}

/**
 * Interactive login. Asks the user to pick Builder ID, IdC, or Desktop,
 * then runs the appropriate flow.
 *
 * Uses `callbacks.onPrompt`, which is the path pi's login-dialog is wired
 * to. Escape/ctrl+c rejects the promise with "Login cancelled", propagating
 * out of this function automatically.
 */
export async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<KiroCredentials> {
  const method = await callbacks.onSelect({
    message: "Select login method:",
    options: [
      { id: "builder-id", label: "AWS Builder ID (personal account)" },
      { id: "idc",        label: "IAM Identity Center (enterprise SSO)" },
      { id: "sync",       label: "Import from Kiro IDE (auto-sync local DB)" },
      { id: "desktop",    label: "Desktop refresh token (manual)" },
    ],
  });

  if (!method) throw new Error("Login cancelled");

  // ── Kiro CLI Sync ───────────────────────────────────────────────
  if (method === "sync") {
    return loginCliSync(callbacks);
  }

  // ── Desktop (manual refresh token) ──────────────────────────────
  if (method === "desktop") {
    return loginDesktopManual(callbacks);
  }

  // ── Builder ID ──────────────────────────────────────────────────
  if (method === "builder-id") {
    return runDeviceCodeFlow(callbacks, BUILDER_ID_START_URL, [BUILDER_ID_REGION], "builder-id");
  }

  // ── IdC ─────────────────────────────────────────────────────────
  const startUrl = (await callbacks.onPrompt({
    message: "Paste your IAM Identity Center start URL:",
    placeholder: "https://mycompany.awsapps.com/start",
    allowEmpty: false,
  }))?.trim();

  if (!startUrl || !startUrl.startsWith("http")) {
    throw new Error(
      `Invalid start URL "${startUrl ?? ""}" — expected https://…`,
    );
  }

  const regionRaw = await callbacks.onPrompt({
    message: `Identity Center region, or blank to auto-detect (${IDC_PROBE_REGIONS.join(", ")})`,
    placeholder: "us-east-1",
    allowEmpty: true,
  });

  const region = (regionRaw ?? "").trim();
  const regions = region ? [region] : IDC_PROBE_REGIONS;
  callbacks.onProgress?.(
    region ? `Connecting to ${region}…` : "Detecting your Identity Center region…",
  );

  return runDeviceCodeFlow(callbacks, startUrl, regions, "idc");
}

/**
 * CLI Sync login: auto-import credentials from Kiro IDE's local SQLite DB.
 * Fails with a clear message if Kiro IDE is not installed or has no valid tokens.
 */
async function loginCliSync(callbacks: OAuthLoginCallbacks): Promise<KiroCredentials> {
  callbacks.onProgress?.("Scanning for Kiro IDE credentials (~/.kiro/db)…");

  const { importFromKiroCli } = await import("./kiro-cli-sync");
  const imported = await importFromKiroCli();

  if (!imported || (!imported.accessToken && !imported.refreshToken)) {
    throw new Error(
      "No Kiro IDE credentials found.\n" +
      "Make sure Kiro IDE is installed and you're logged in, then try again.\n" +
      "Alternatively, use 'desktop' to paste a refresh token manually.",
    );
  }

  log.info("Successfully imported credentials from Kiro IDE");
  callbacks.onProgress?.(
    `Imported from Kiro IDE (${imported.authMethod}, ${imported.region}` +
    `${imported.email ? `, ${imported.email}` : ""})`,
  );

  try {
    const apiRegion = resolveApiRegion(imported.region);
    const apiModels = await fetchAvailableModels(imported.accessToken, apiRegion);
    setCachedDynamicModels(buildModelsFromApi(apiModels));
    log.info(`Fetched and cached ${apiModels.length} models after CLI sync`);
  } catch (err) {
    log.warn(`Failed to fetch models after CLI sync: ${err}`);
  }

  const refreshPacked = imported.clientId
    ? `${imported.refreshToken}|${imported.clientId}|${imported.clientSecret ?? ""}|${imported.authMethod}`
    : `${imported.refreshToken}|||desktop`;

  return {
    refresh: refreshPacked,
    access: imported.accessToken,
    expires: Date.now() + 3600 * 1000 - EXPIRES_BUFFER_MS,
    clientId: imported.clientId ?? "",
    clientSecret: imported.clientSecret ?? "",
    region: imported.region,
    authMethod: imported.authMethod,
  };
}

/**
 * Desktop manual login: prompt the user for a raw refresh token
 * and region, then exchange it for an access token via the desktop
 * auth endpoint.
 */
async function loginDesktopManual(callbacks: OAuthLoginCallbacks): Promise<KiroCredentials> {
  const refreshRaw = await callbacks.onPrompt({
    message:
      "Paste your Kiro desktop refresh token\n" +
      "(find it in ~/.kiro/db/kiro.db → auth_kv table):",
    placeholder: "refresh-token",
    allowEmpty: true,
  });

  const refreshToken = (refreshRaw ?? "").trim();
  if (!refreshToken) {
    throw new Error("Login cancelled — no refresh token provided");
  }

  const regionRaw = await callbacks.onPrompt({
    message: "Kiro region:",
    placeholder: "us-east-1",
    allowEmpty: true,
  });
  const region = (regionRaw ?? "").trim() || "us-east-1";

  const refreshCreds: KiroCredentials = {
    refresh: `${refreshToken}|||desktop`,
    access: "",
    expires: 0,
    clientId: "",
    clientSecret: "",
    region,
    authMethod: "desktop",
  };

  callbacks.onProgress?.("Exchanging refresh token…");
  return refreshKiroToken(refreshCreds);
}


async function runDeviceCodeFlow(
  callbacks: OAuthLoginCallbacks,
  startUrl: string,
  regions: string[],
  authMethod: "builder-id" | "idc",
): Promise<KiroCredentials> {
  let result: Awaited<ReturnType<typeof tryRegisterAndAuthorize>> | null = null;
  let detectedRegion = "";
  for (const region of regions) {
    result = await tryRegisterAndAuthorize(startUrl, region);
    if (result) {
      detectedRegion = region;
      if (regions.length > 1) callbacks.onProgress?.(`Region: ${region}`);
      break;
    }
  }
  if (!result || !detectedRegion) {
    throw new Error(
      `Could not authorize ${startUrl} in ${regions.join(", ")}. ` +
        `Check your start URL${regions.length === 1 ? " and region" : ""} and try again.`,
    );
  }

  // Pi's login-dialog renders `url` prominently (clickable link on macOS)
  // and auto-opens the browser. `instructions` appears below in warning
  // color — use it for the code + expiry hint only. Don't duplicate the URL.
  callbacks.onAuth({
    url: result.devAuth.verificationUriComplete,
    instructions: `Code: ${result.devAuth.userCode}\nComplete authorization within 10 minutes.`,
  });

  callbacks.onProgress?.("Waiting for browser authorization (up to 10 minutes)…");

  const tok = await pollForToken(
    result.oidcEndpoint,
    result.clientId,
    result.clientSecret,
    result.devAuth,
    callbacks.signal,
  );
  if (!tok.accessToken || !tok.refreshToken) {
    throw new Error("Authorization completed but no tokens returned");
  }

  try {
    const apiRegion = resolveApiRegion(detectedRegion);
    const apiModels = await fetchAvailableModels(tok.accessToken, apiRegion);
    setCachedDynamicModels(buildModelsFromApi(apiModels));
    log.info(`Fetched and cached ${apiModels.length} models after login`);
  } catch (err) {
    log.warn(`Failed to fetch models after login, falling back: ${err}`);
  }

  return {
    refresh: `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|${authMethod}`,
    access: tok.accessToken,
    expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId: result.clientId,
    clientSecret: result.clientSecret,
    region: detectedRegion,
    authMethod,
  };
}

/**
 * Sync refreshed credentials back to the Kiro CLI DB.
 * Fire-and-forget — a failed write-back is non-fatal.
 */
async function syncBackToKiroCli(result: KiroCredentials): Promise<void> {
  try {
    const { saveKiroCliCredentials } = await import("./kiro-cli-sync");
    const synced = await saveKiroCliCredentials({
      accessToken: result.access,
      refreshToken: result.refresh.split("|")[0] ?? "",
      region: result.region,
      authMethod: result.authMethod === "builder-id" ? "idc" : result.authMethod,
    });
    if (synced) log.info("Synced refreshed credentials back to Kiro CLI DB");
  } catch (err) {
    log.debug(`Credential sync-back skipped: ${err}`);
  }
}

/**
 * Build KiroCredentials from a KiroCliCredentials import.
 * Used by the fallback layers of the refresh cascade.
 */
function kiroCredsFromCliImport(imported: KiroCliCredentials): KiroCredentials {
  const authMethod: "builder-id" | "idc" | "desktop" =
    imported.authMethod === "idc" ? "idc" : "desktop";
  const refreshPacked = imported.clientId
    ? `${imported.refreshToken}|${imported.clientId}|${imported.clientSecret ?? ""}|${authMethod}`
    : `${imported.refreshToken}|||desktop`;

  return {
    refresh: refreshPacked,
    access: imported.accessToken,
    expires: Date.now() + 3600 * 1000 - EXPIRES_BUFFER_MS,
    clientId: imported.clientId ?? "",
    clientSecret: imported.clientSecret ?? "",
    region: imported.region,
    authMethod,
  };
}

/**
 * Core token refresh against the appropriate endpoint (OIDC or desktop).
 * This is the "inner" refresh — extracted so the cascade can call it
 * with different credential sets.
 *
 * Throws on failure (caller catches and falls through to next layer).
 */
async function refreshTokenInner(credentials: KiroCredentials): Promise<KiroCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const clientId = parts[1] ?? credentials.clientId ?? "";
  const clientSecret = parts[2] ?? credentials.clientSecret ?? "";
  const region = credentials.region;
  const authMethod = credentials.authMethod;

  if (!refreshToken || !region) {
    throw new Error("Refresh token is missing region — re-login required");
  }
  if (authMethod !== "desktop" && (!clientId || !clientSecret)) {
    throw new Error("Refresh token is missing clientId/clientSecret — re-login required");
  }

  // Desktop auth uses Kiro's own auth endpoint (no OIDC client required).
  if (authMethod === "desktop") {
    const desktopEndpoint = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
    const resp = await fetch(desktopEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Desktop token refresh failed: ${resp.status} ${body}`);
    }

    const data = (await resp.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresIn?: number;
    };

    try {
      const apiRegion = resolveApiRegion(region);
      const apiModels = await fetchAvailableModels(data.accessToken, apiRegion);
      setCachedDynamicModels(buildModelsFromApi(apiModels));
      log.info(`Fetched and cached ${apiModels.length} models after desktop token refresh`);
    } catch (err) {
      log.warn(`Failed to fetch models after desktop token refresh: ${err}`);
    }

    return {
      refresh: `${data.refreshToken}|||desktop`,
      access: data.accessToken,
      expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
    };
  }

  const endpoint = `https://oidc.${region}.amazonaws.com/token`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Token refresh failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
  };

  try {
    const apiRegion = resolveApiRegion(region);
    const apiModels = await fetchAvailableModels(data.accessToken, apiRegion);
    setCachedDynamicModels(buildModelsFromApi(apiModels));
    log.info(`Fetched and cached ${apiModels.length} models after token refresh`);
  } catch (err) {
    log.warn(`Failed to fetch models after token refresh, falling back: ${err}`);
  }

  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|${authMethod}`,
    access: data.accessToken,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region,
    authMethod,
  };
}

/**
 * 5-layer credential refresh cascade.
 *
 * Layers (each falls through to the next on failure):
 *   1. Normal OIDC/desktop refresh with current credentials
 *   2. Import fresh credentials from Kiro CLI DB → use as-is
 *   3. Import fresh credentials from Kiro CLI DB → refresh those
 *   4. Import expired credentials from Kiro CLI DB → use as-is
 *   5. Import expired credentials from Kiro CLI DB → refresh those
 *
 * After any successful refresh, the new tokens are synced back to the
 * Kiro CLI DB (fire-and-forget) for bidirectional sync.
 */
export async function refreshKiroToken(
  credentials: OAuthCredentials,
): Promise<KiroCredentials> {
  const inputMethod = (credentials as Partial<KiroCredentials>).authMethod;
  const authMethod: "builder-id" | "idc" | "desktop" =
    inputMethod === "builder-id" || inputMethod === "idc" || inputMethod === "desktop"
      ? inputMethod
      : "idc";
  if (
    inputMethod !== undefined &&
    inputMethod !== "builder-id" &&
    inputMethod !== "idc" &&
    inputMethod !== "desktop"
  ) {
    log.warn(`refreshKiroToken: unrecognized authMethod "${String(inputMethod)}" — defaulting to "idc"`);
  }

  const baseCreds: KiroCredentials = {
    ...credentials,
    clientId: (credentials as KiroCredentials).clientId ?? credentials.refresh.split("|")[1] ?? "",
    clientSecret: (credentials as KiroCredentials).clientSecret ?? credentials.refresh.split("|")[2] ?? "",
    region: (credentials as KiroCredentials).region,
    authMethod,
  };

  const errors: string[] = [];

  // ── Layer 1: Normal refresh with current credentials ──────────
  try {
    log.debug("refresh.cascade: layer 1 — normal refresh");
    const result = await refreshTokenInner(baseCreds);
    void syncBackToKiroCli(result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`L1(normal): ${msg}`);
    log.warn(`refresh.cascade: layer 1 failed — ${msg}`);
  }

  // ── Layer 2: Import fresh Kiro CLI credentials → use as-is ────
  let freshImport: KiroCliCredentials | null = null;
  try {
    log.debug("refresh.cascade: layer 2 — fresh kiro-cli import");
    const { importFromKiroCli } = await import("./kiro-cli-sync");
    freshImport = await importFromKiroCli();
    if (freshImport?.accessToken) {
      const result = kiroCredsFromCliImport(freshImport);
      log.info("refresh.cascade: layer 2 succeeded — using fresh kiro-cli credentials");
      return result;
    }
    errors.push("L2(fresh-import): no valid credentials found");
    log.debug("refresh.cascade: layer 2 — no fresh credentials");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`L2(fresh-import): ${msg}`);
    log.warn(`refresh.cascade: layer 2 failed — ${msg}`);
  }

  // ── Layer 3: Refresh the fresh Kiro CLI credentials ───────────
  if (freshImport?.refreshToken) {
    try {
      log.debug("refresh.cascade: layer 3 — refresh fresh kiro-cli creds");
      const freshCreds = kiroCredsFromCliImport(freshImport);
      const result = await refreshTokenInner(freshCreds);
      void syncBackToKiroCli(result);
      log.info("refresh.cascade: layer 3 succeeded — refreshed fresh kiro-cli credentials");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`L3(refresh-fresh): ${msg}`);
      log.warn(`refresh.cascade: layer 3 failed — ${msg}`);
    }
  }

  // ── Layer 4: Import expired Kiro CLI credentials → use as-is ──
  let expiredImport: KiroCliCredentials | null = null;
  try {
    log.debug("refresh.cascade: layer 4 — expired kiro-cli import");
    const { getKiroCliCredentialsAllowExpired } = await import("./kiro-cli-sync");
    expiredImport = await getKiroCliCredentialsAllowExpired();
    if (expiredImport?.accessToken && expiredImport !== freshImport) {
      const result = kiroCredsFromCliImport(expiredImport);
      log.info("refresh.cascade: layer 4 succeeded — using expired kiro-cli credentials");
      return result;
    }
    errors.push("L4(expired-import): no different expired credentials");
    log.debug("refresh.cascade: layer 4 — no additional expired credentials");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`L4(expired-import): ${msg}`);
    log.warn(`refresh.cascade: layer 4 failed — ${msg}`);
  }

  // ── Layer 5: Refresh the expired Kiro CLI credentials ─────────
  if (expiredImport?.refreshToken) {
    try {
      log.debug("refresh.cascade: layer 5 — refresh expired kiro-cli creds");
      const expiredCreds = kiroCredsFromCliImport(expiredImport);
      const result = await refreshTokenInner(expiredCreds);
      void syncBackToKiroCli(result);
      log.info("refresh.cascade: layer 5 succeeded — refreshed expired kiro-cli credentials");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`L5(refresh-expired): ${msg}`);
      log.warn(`refresh.cascade: layer 5 failed — ${msg}`);
    }
  }

  // All layers exhausted.
  throw new Error(
    `Kiro token refresh failed — all 5 cascade layers exhausted. ` +
    `Re-login required.\n${errors.join("\n")}`,
  );
}
