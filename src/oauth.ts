// Kiro OAuth — AWS Builder ID, IAM Identity Center (IdC), and local import.
//
// Login methods, selected interactively:
//
//   1. Builder ID — Kiro's social sign-in (PKCE + localhost callback, same
//      flow as kiro-cli), always us-east-1. Refreshes via the Kiro desktop
//      auth endpoint. If the portal hands off to enterprise SSO, the flow
//      continues as IdC.
//   2. IdC — enterprise SSO. User supplies their company start URL
//      (e.g. https://mycompany.awsapps.com/start); region is auto-detected
//      across common AWS regions, or the user can specify it. Uses the AWS
//      SSO-OIDC device-code flow and refresh endpoint.
//   3. Import from the local kiro-cli DB / Kiro IDE SSO cache.
//   4. Desktop — a pasted Kiro desktop refresh token.
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
import {
  fetchAvailableModels,
  buildModelsFromApi,
  resolveApiRegion,
  setCachedDynamicModels,
  resolveProfileArn,
} from "./models";
import type { KiroCliCredentials, KiroCredentialSource } from "./kiro-cli-sync";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

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

const AUTH_METHODS = ["builder-id", "idc", "desktop", "social"] as const;

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
   * - `social`: Builder ID via Kiro's social sign-in (refreshes like `desktop`).
   */
  authMethod: (typeof AUTH_METHODS)[number];
  /** Profile ARN from Kiro, used to scope API calls. */
  profileArn?: string;
  /** Local Kiro source, used only to decide safe CLI DB write-back. */
  kiroSyncSource?: KiroCredentialSource;
  /** Exact `auth_kv.key` imported from the kiro-cli DB. */
  kiroSyncTokenKey?: string;
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
    await sleep(interval, undefined, { signal });

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

// ── Social sign-in (PKCE + authorization code) ──────────────────────
//
// Used for Builder ID (personal AWS account). Matches the Kiro CLI flow:
// opens https://app.kiro.dev/signin with a PKCE challenge, listens on a
// localhost port for the OAuth redirect, then exchanges the authorization
// code for tokens via the desktop auth endpoint.
//
// Key advantage over the device-code flow: the token exchange returns
// profileArn immediately, eliminating the post-login resolution step.

const KIRO_SOCIAL_PORTAL = "https://app.kiro.dev";
const KIRO_SOCIAL_AUTH_ENDPOINT = `https://prod.${BUILDER_ID_REGION}.auth.desktop.kiro.dev`;
const SOCIAL_REDIRECT_PORT = 49153;
const SOCIAL_REDIRECT_URI = `http://localhost:${SOCIAL_REDIRECT_PORT}`;

function buildSocialSignInURL(redirectUri: string, codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_from: "kirocli",
    redirect_uri: redirectUri,
    state,
  });
  return `${KIRO_SOCIAL_PORTAL}/signin?${params}`;
}

function parseAuthRedirectInput(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL — treat as a raw authorization code.
    return { code: trimmed };
  }
}

/**
 * Reconstruct the redirect_uri for the token exchange.
 * Kiro redirects the browser to {baseURI}/oauth/callback?login_option=...
 * and the token endpoint expects this exact URI back.
 * Matches sub2api's BuildSocialTokenRedirectURI.
 */
function buildTokenRedirectUri(callbackPath: string, loginOption: string | null): string {
  const path = callbackPath || "/oauth/callback";
  const base = `${SOCIAL_REDIRECT_URI}${path}`;
  if (loginOption) {
    return `${base}?login_option=${encodeURIComponent(loginOption)}`;
  }
  return base;
}

/** Minimal page served to the browser on the OAuth callback server. */
function oauthPage(title: string, body: string, head = ""): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pi-kiro — ${title}</title>${head}</head>` +
    `<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:20vh">` +
    `<h1>${title}</h1>${body}</body></html>`;
}

const SIGNED_IN_PAGE = oauthPage(
  "Signed in",
  "<p>You can close this tab. Redirecting to app.kiro.dev…</p>",
  '<meta http-equiv="refresh" content="3;url=https://app.kiro.dev">',
);

/** Enterprise IdC hand-off: poll /idc-verify, then follow the device verification URL. */
const IDC_DELEGATION_PAGE = oauthPage(
  "Enterprise sign-in",
  "<p>Preparing device authorization…</p>" +
    "<script>(function poll(){fetch('/idc-verify').then(function(r){return r.json()})" +
    ".then(function(d){if(d.url)location.href=d.url;else setTimeout(poll,500)},function(){setTimeout(poll,1000)})})()</script>",
);

function startCallbackServer(
  expectedState: string,
): Promise<{
  server: Server;
  redirectUri: string;
  waitForCode: () => Promise<SocialCallbackResult | null>;
  cancelWait: () => void;
  setIdcVerifyUrl: (url: string) => void;
}> {
  return new Promise((resolve, reject) => {
    let settleWait: ((result: SocialCallbackResult | null) => void) | undefined;
    const waitForCodePromise = new Promise<SocialCallbackResult | null>((res) => {
      settleWait = res;
    });

    let idcVerifyUrl: string | null = null;

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", SOCIAL_REDIRECT_URI);

        // /idc-verify endpoint: returns the device verification URL when ready.
        if (url.pathname === "/idc-verify") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ url: idcVerifyUrl }));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const loginOption = url.searchParams.get("login_option");
        const issuerUrl = url.searchParams.get("issuer_url");
        const idcRegion = url.searchParams.get("idc_region");

        // IdC delegation: login_option=awsidc + issuer_url + state (no code)
        const isIdcDelegation = loginOption === "awsidc" && !!issuerUrl && !!state;

        if (!state || (!code && !isIdcDelegation)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("");
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthPage("State mismatch", "<p>The OAuth state parameter did not match. Please try logging in again.</p>"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(isIdcDelegation ? IDC_DELEGATION_PAGE : SIGNED_IN_PAGE);
        settleWait?.({
          code,
          state,
          callbackPath: url.pathname,
          loginOption,
          issuerUrl: issuerUrl ?? undefined,
          idcRegion: idcRegion ?? undefined,
        });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      }
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(SOCIAL_REDIRECT_PORT, "localhost", () => {
      resolve({
        server,
        redirectUri: SOCIAL_REDIRECT_URI,
        cancelWait: () => { settleWait?.(null); },
        waitForCode: () => waitForCodePromise,
        setIdcVerifyUrl: (url: string) => { idcVerifyUrl = url; },
      });
    });
  });
}

/** Fetch this account's model list and cache it for the provider. Non-fatal. */
async function cacheModels(
  accessToken: string,
  region: string,
  profileArn: string,
  after: string,
): Promise<void> {
  try {
    const apiModels = await fetchAvailableModels(accessToken, resolveApiRegion(region), profileArn);
    setCachedDynamicModels(buildModelsFromApi(apiModels));
    log.info(`Fetched and cached ${apiModels.length} models after ${after}`);
  } catch (err) {
    log.warn(`Failed to fetch models after ${after}: ${err}`);
  }
}

/** Result from the localhost callback server. */
interface SocialCallbackResult {
  /** Authorization code (null for IdC delegation). */
  code: string | null;
  state: string;
  callbackPath: string;
  loginOption: string | null;
  /** IdC delegation: the issuer/start URL from Kiro portal. */
  issuerUrl?: string;
  /** IdC delegation: the IdC region from Kiro portal. */
  idcRegion?: string;
}

interface SocialTokenResponse {
  accessToken: string;
  refreshToken: string;
  profileArn?: string;
  expiresIn?: number;
}

async function runSocialSignInFlow(
  callbacks: OAuthLoginCallbacks,
): Promise<KiroCredentials> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const callbackServer = await startCallbackServer(state);

  try {
    const signInUrl = buildSocialSignInURL(callbackServer.redirectUri, challenge, state);

    callbacks.onAuth({
      url: signInUrl,
      instructions: "Complete sign-in in your browser.",
    });

    callbacks.onProgress?.("Waiting for browser sign-in…");

    let code: string | undefined;
    let tokenRedirectUri = SOCIAL_REDIRECT_URI;

    // Race: localhost callback vs manual code input (if available).
    let callbackResult: SocialCallbackResult | null = null;

    if (callbacks.onManualCodeInput) {
      let manualInput: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualInput = input;
          callbackServer.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          callbackServer.cancelWait();
        });

      callbackResult = await callbackServer.waitForCode();

      if (manualError) throw manualError;

      // IdC delegation: skip manual-input fallback — no code expected.
      if (callbackResult?.loginOption !== "awsidc" || !callbackResult.issuerUrl) {
        if (callbackResult?.code) {
          code = callbackResult.code;
          tokenRedirectUri = buildTokenRedirectUri(callbackResult.callbackPath, callbackResult.loginOption);
        } else if (manualInput) {
          code = parseAuthRedirectInput(manualInput).code;
        }

        if (!code) {
          await manualPromise;
          if (manualError) throw manualError;
          if (manualInput) {
            code = parseAuthRedirectInput(manualInput).code;
          }
        }
      }
    } else {
      callbackResult = await callbackServer.waitForCode();
      if (callbackResult?.code) {
        code = callbackResult.code;
        tokenRedirectUri = buildTokenRedirectUri(callbackResult.callbackPath, callbackResult.loginOption);
      }
    }

    // IdC delegation: Kiro portal redirected with issuer_url + idc_region.
    // Keep the callback server alive so the browser can poll /idc-verify.
    // Wrap callbacks.onAuth to pipe the verification URL to the browser tab.
    if (callbackResult?.loginOption === "awsidc" && callbackResult.issuerUrl) {
      callbacks.onProgress?.("Enterprise sign-in detected — starting device authorization…");
      const idcRegion = callbackResult.idcRegion || BUILDER_ID_REGION;
      const wrappedCallbacks: OAuthLoginCallbacks = {
        ...callbacks,
        onAuth: (info) => {
          // Pipe the verification URL to the browser tab via /idc-verify
          callbackServer.setIdcVerifyUrl(info.url);
          // Log instructions to progress so the user has them in the terminal,
          // but do NOT call callbacks.onAuth to avoid opening a redundant browser tab.
          if (info.instructions) {
            callbacks.onProgress?.(info.instructions);
          }
        },
      };
      try {
        return await runDeviceCodeFlow(wrappedCallbacks, callbackResult.issuerUrl, [idcRegion]);
      } finally {
        callbackServer.server.close();
      }
    }

    // Fallback: prompt the user to paste the redirect URL or code.
    if (!code) {
      const input = await callbacks.onPrompt({
        message: "Paste the authorization code or the full redirect URL:",
        placeholder: SOCIAL_REDIRECT_URI,
      });
      code = parseAuthRedirectInput(input).code;
    }

    if (!code) {
      throw new Error("Missing authorization code — sign-in was not completed");
    }

    callbacks.onProgress?.("Exchanging authorization code…");

    const resp = await fetch(`${KIRO_SOCIAL_AUTH_ENDPOINT}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        redirect_uri: tokenRedirectUri,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Token exchange failed: ${resp.status} ${body}`);
    }

    const data = (await resp.json()) as SocialTokenResponse;

    if (!data.accessToken || !data.refreshToken) {
      throw new Error("Token exchange returned no tokens");
    }

    // Social flow returns profileArn — fetch and cache models immediately.
    if (data.profileArn) {
      await cacheModels(data.accessToken, BUILDER_ID_REGION, data.profileArn, "social sign-in");
    }

    return {
      refresh: `${data.refreshToken}|||social`,
      access: data.accessToken,
      expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
      clientId: "",
      clientSecret: "",
      region: BUILDER_ID_REGION,
      authMethod: "social",
      profileArn: data.profileArn,
    };
  } finally {
    callbackServer.server.close();
  }
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
      { id: "sync",       label: "Import from Kiro CLI/IDE (auto-sync local DB)" },
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

  // ── Builder ID (social sign-in with PKCE) ──────────────────────
  if (method === "builder-id") {
    return runSocialSignInFlow(callbacks);
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

  return runDeviceCodeFlow(callbacks, startUrl, regions);
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

  if (imported.profileArn) {
    await cacheModels(imported.accessToken, imported.region, imported.profileArn, "CLI sync");
  }

  // Route through kiroCredsFromCliImport so the struct `authMethod` is
  // aligned with the refresh endpoint we can actually hit. The SSO cache
  // fallback has no OIDC clientId/secret, so authMethod is forced to
  // "desktop" there and the pack ends in "|||desktop" — keeping both
  // consistent prevents the next refresh from failing the
  // "missing clientId/clientSecret" precheck.
  return kiroCredsFromCliImport(imported);
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

  // Resolve profileArn immediately after successful authorization so models can load without restarting pi.
  callbacks.onProgress?.("Resolving Kiro profile…");
  let profileArn: string | undefined;
  try {
    const resolved = await resolveProfileArn(tok.accessToken, resolveApiRegion(detectedRegion));
    if (resolved) {
      profileArn = resolved;
      log.info(`Resolved profileArn during login: ${profileArn}`);
      await cacheModels(tok.accessToken, detectedRegion, profileArn, "login");
    } else {
      log.warn("Could not resolve profileArn during login");
    }
  } catch (err) {
    log.warn(`Failed to resolve profileArn during login: ${err}`);
  }

  return {
    refresh: `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|idc`,
    access: tok.accessToken,
    expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId: result.clientId,
    clientSecret: result.clientSecret,
    region: detectedRegion,
    authMethod: "idc",
    ...(profileArn ? { profileArn } : {}),
  };
}

/**
 * Sync refreshed credentials back to the Kiro CLI DB.
 * Fire-and-forget — a failed write-back is non-fatal. saveKiroCliCredentials
 * only writes credentials imported from a specific kiro-cli DB token row;
 * Kiro IDE SSO cache / desktop refresh tokens are a different token family
 * and are never written into the CLI DB.
 */
async function syncBackToKiroCli(result: KiroCredentials): Promise<void> {
  try {
    const { saveKiroCliCredentials } = await import("./kiro-cli-sync");
    const synced = await saveKiroCliCredentials({
      accessToken: result.access,
      refreshToken: result.refresh.split("|")[0] ?? "",
      region: result.region,
      authMethod: result.authMethod === "builder-id" || result.authMethod === "social" ? "desktop" : result.authMethod,
      source: result.kiroSyncSource,
      tokenKey: result.kiroSyncTokenKey,
    });
    if (synced) log.info("Synced refreshed credentials back to Kiro CLI DB");
  } catch (err) {
    log.debug(`Credential sync-back skipped: ${err}`);
  }
}

/**
 * Build KiroCredentials from a KiroCliCredentials import.
 * Used by the fallback layers of the refresh cascade.
 *
 * `authMethod` is derived from what's actually refreshable: the OIDC path
 * needs clientId+clientSecret, and the only viable refresh path without
 * them is the desktop endpoint. When clientId is missing, the struct
 * `authMethod` is forced to `"desktop"` so the next refresh hits the
 * correct endpoint instead of failing the "missing clientId/clientSecret"
 * precheck in `refreshTokenInner`.
 */
function kiroCredsFromCliImport(imported: KiroCliCredentials): KiroCredentials {
  const hasOidcCreds = !!imported.clientId && !!imported.clientSecret;
  const authMethod: "builder-id" | "idc" | "desktop" =
    hasOidcCreds && imported.authMethod === "idc"
      ? "idc"
      : "desktop";
  const refreshPacked = hasOidcCreds
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
    profileArn: imported.profileArn,
    kiroSyncSource: imported.source,
    kiroSyncTokenKey: imported.tokenKey,
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
  const { region, authMethod } = credentials;
  // Desktop/social auth uses Kiro's own auth endpoint (no OIDC client required).
  const desktop = authMethod === "desktop" || authMethod === "social";

  if (!refreshToken || !region) {
    throw new Error("Refresh token is missing region — re-login required");
  }
  if (!desktop && (!clientId || !clientSecret)) {
    throw new Error("Refresh token is missing clientId/clientSecret — re-login required");
  }

  const resp = await fetch(
    desktop
      ? `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
      : `https://oidc.${region}.amazonaws.com/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
      body: JSON.stringify(
        desktop ? { refreshToken } : { clientId, clientSecret, refreshToken, grantType: "refresh_token" },
      ),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${desktop ? "Desktop token" : "Token"} refresh failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
  };

  let profileArn = credentials.profileArn;
  if (!profileArn) {
    try {
      profileArn = (await resolveProfileArn(data.accessToken, resolveApiRegion(region))) ?? undefined;
      if (profileArn) log.info(`Resolved profileArn during token refresh: ${profileArn}`);
    } catch (err) {
      log.warn(`Failed to resolve profileArn during token refresh: ${err}`);
    }
  }
  if (profileArn) await cacheModels(data.accessToken, region, profileArn, "token refresh");

  return {
    refresh: desktop
      ? `${data.refreshToken}|||${authMethod}`
      : `${data.refreshToken}|${clientId}|${clientSecret}|${authMethod}`,
    access: data.accessToken,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId: desktop ? "" : clientId,
    clientSecret: desktop ? "" : clientSecret,
    region,
    authMethod,
    profileArn,
    kiroSyncSource: credentials.kiroSyncSource,
    kiroSyncTokenKey: credentials.kiroSyncTokenKey,
  };
}

/**
 * 3-layer credential refresh cascade.
 *
 * Layers (each falls through to the next on failure):
 *   1. Normal OIDC/desktop refresh with current credentials
 *   2. Import fresh credentials from Kiro CLI DB → use as-is
 *   3. Import fresh credentials from Kiro CLI DB → refresh those
 *
 * After any successful refresh, the new tokens are synced back to the
 * Kiro CLI DB (fire-and-forget) for bidirectional sync.
 */
export async function refreshKiroToken(
  credentials: OAuthCredentials,
): Promise<KiroCredentials> {
  const inputMethod = (credentials as Partial<KiroCredentials>).authMethod;
  const knownMethod = AUTH_METHODS.find((m) => m === inputMethod);
  if (inputMethod !== undefined && !knownMethod) {
    log.warn(`refreshKiroToken: unrecognized authMethod "${String(inputMethod)}" — defaulting to "idc"`);
  }

  const baseCreds: KiroCredentials = {
    ...credentials,
    clientId: (credentials as KiroCredentials).clientId ?? credentials.refresh.split("|")[1] ?? "",
    clientSecret: (credentials as KiroCredentials).clientSecret ?? credentials.refresh.split("|")[2] ?? "",
    region: (credentials as KiroCredentials).region,
    authMethod: knownMethod ?? "idc",
  };

  const refreshAndSync = async (creds: KiroCredentials): Promise<KiroCredentials> => {
    const result = await refreshTokenInner(creds);
    void syncBackToKiroCli(result);
    return result;
  };

  let freshImport: KiroCliCredentials | null = null;
  const layers: Array<[string, () => Promise<KiroCredentials | null>]> = [
    ["L1(normal)", () => refreshAndSync(baseCreds)],
    ["L2(fresh-import)", async () => {
      const { importFromKiroCli } = await import("./kiro-cli-sync");
      freshImport = await importFromKiroCli();
      return freshImport?.accessToken ? kiroCredsFromCliImport(freshImport) : null;
    }],
    ["L3(refresh-fresh)", async () =>
      freshImport?.refreshToken ? refreshAndSync(kiroCredsFromCliImport(freshImport)) : null],
  ];

  const errors: string[] = [];
  for (const [name, attempt] of layers) {
    try {
      log.debug(`refresh.cascade: ${name}`);
      const result = await attempt();
      if (result) {
        log.info(`refresh.cascade: ${name} succeeded`);
        return result;
      }
      errors.push(`${name}: no valid credentials found`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      log.warn(`refresh.cascade: ${name} failed — ${msg}`);
    }
  }

  throw new Error(
    `Kiro token refresh failed — all ${layers.length} cascade layers exhausted. ` +
    `Re-login required.\n${errors.join("\n")}`,
  );
}
