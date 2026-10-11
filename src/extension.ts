// pi-kiro extension entry point.
//
// Referenced from package.json: "pi": { "extensions": ["./dist/extension.js"] }.
// Called once by pi at startup; registers the kiro provider with its model
// catalog, OAuth login, and custom streaming handler.
//
// TODO: pi should prevent /login from firing mid-turn. Until enforced
// upstream, loginKiro assumes the agent is idle.
//
// TODO: fetchUsage is not part of the documented ProviderConfig contract in
// pi-coding-agent. When upstream pi documents the fetchUsage hook, add
// `fetchUsage: fetchKiroUsage` here to expose Kiro subscription usage in
// pi's /settings view. Until then, users check their usage at
// https://app.kiro.dev/account/usage.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  buildModelsFromApi,
  fetchAvailableModels,
  filterModelsByRegion,
  getCachedDynamicModels,
  kiroModels,
  PI_TO_KIRO_EFFORT,
  readModelDiskCache,
  resolveApiRegion,
  resolveProfileArn,
  resolveRuntimeUrl,
  setCachedDynamicModels,
  writeModelDiskCache,
  type KiroModelDef,
} from "./models";
import { loginKiro, refreshKiroToken, type KiroCredentials } from "./oauth";
import { streamKiro, seedProfileArn } from "./stream";
import { log } from "./debug";

// Local structural subset of pi's ExtensionAPI / ProviderConfig. pi-kiro
// only calls `pi.registerProvider(...)`, so we declare just that method
// plus the config shape we actually pass. Declared locally (not imported
// from @earendil-works/pi-coding-agent) so this package has no install-time
// dependency on the pi host's version. Any real pi ExtensionAPI satisfies
// this interface structurally.
interface ProviderModelConfig {
  id: string;
  name: string;
  api?: Api;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
  firstTokenTimeout?: number;
  reasoningHidden?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ProviderModelConfig[];
  oauth?: {
    name: string;
    login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
    refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
    getApiKey: (credentials: OAuthCredentials) => string;
    modifyModels?: (models: Model<Api>[], credentials: OAuthCredentials) => Model<Api>[];
  };
}

interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): void;
}

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const AUTO_MODEL: KiroModelDef = kiroModels.find((model) => model.id === "auto")!;

/** Keep Auto available while an older disk cache is refreshed. */
function withAutoModel(models: readonly KiroModelDef[]): KiroModelDef[] {
  return models.some((model) => model.id === "auto") ? [...models] : [...models, AUTO_MODEL];
}

function toProviderModels(defs: readonly KiroModelDef[]): ProviderModelConfig[] {
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    reasoning: d.reasoning,
    input: d.input,
    cost: ZERO_COST,
    contextWindow: d.contextWindow,
    maxTokens: d.maxTokens,
    firstTokenTimeout: d.firstTokenTimeout,
    ...(d.reasoningHidden ? { reasoningHidden: d.reasoningHidden } : {}),
    ...(d.reasoning
      ? {
          thinkingLevelMap: PI_TO_KIRO_EFFORT,
          compat: { forceAdaptiveThinking: true },
        }
      : {}),
  }));
}

/** Read kiro credentials from pi's auth.json if available. */
function readKiroCredentials(): {
  access: string;
  refresh: string;
  expires: number;
  region: string;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  authMethod?: string;
} | null {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return null;
    const raw = readFileSync(authPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const kiro = data["kiro"] as Record<string, unknown> | undefined;
    if (!kiro?.access || typeof kiro.access !== "string") return null;

    // Self-heal: pi's AuthStorage requires `type: "oauth"` to recognize
    // stored OAuth credentials.  If it's missing (e.g. a previous migration
    // or manual edit dropped it), re-inject it so the session doesn't fail
    // with "No API key found for kiro".
    if (kiro.type !== "oauth") {
      log.warn("auth.json kiro entry missing type — injecting type:oauth");
      try {
        data["kiro"] = { ...kiro, type: "oauth" };
        writeFileSync(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      } catch (e) {
        log.warn(`Failed to self-heal auth.json: ${e}`);
      }
    }

    // profileArn lives on the kiro entry; fall back to legacy metadata location.
    const metadata = kiro.metadata as Record<string, unknown> | undefined;
    const profileArn = [kiro.profileArn, metadata?.profileArn].find((v): v is string => typeof v === "string");

    return {
      access: kiro.access as string,
      refresh: typeof kiro.refresh === "string" ? kiro.refresh : "",
      expires: typeof kiro.expires === "number" ? kiro.expires : 0,
      region: (kiro.region as string) || "us-east-1",
      profileArn,
      clientId: typeof kiro.clientId === "string" ? kiro.clientId : undefined,
      clientSecret: typeof kiro.clientSecret === "string" ? kiro.clientSecret : undefined,
      authMethod: typeof kiro.authMethod === "string" ? kiro.authMethod : undefined,
    };
  } catch {
    return null;
  }
}

/** Persist refreshed credentials to pi's auth.json so pi picks them up. */
function writeKiroCredentials(refreshed: KiroCredentials): void {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const raw = existsSync(authPath) ? readFileSync(authPath, "utf-8") : "{}";
    const data = JSON.parse(raw) as Record<string, unknown>;
    const existing = (data["kiro"] as Record<string, unknown> | undefined) ?? {};
    data["kiro"] = {
      ...existing,
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      clientId: refreshed.clientId,
      clientSecret: refreshed.clientSecret,
      region: refreshed.region,
      authMethod: refreshed.authMethod,
      profileArn: refreshed.profileArn,
    };
    writeFileSync(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    log.warn(`Failed to persist refreshed credentials: ${err}`);
  }
}

/** Merge individual fields into the existing kiro entry (e.g. resolved profileArn). */
function writeKiroCredentialsPartial(fields: Record<string, unknown>): void {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const raw = existsSync(authPath) ? readFileSync(authPath, "utf-8") : "{}";
    const data = JSON.parse(raw) as Record<string, unknown>;
    const existing = (data["kiro"] as Record<string, unknown> | undefined) ?? {};
    data["kiro"] = { ...existing, ...fields };
    writeFileSync(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    log.warn(`Failed to persist partial credentials: ${err}`);
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // --- Fast path: load disk-cached models immediately, no network ---
  // `kiroModels` (KiroModel[]) is structurally a superset of KiroModelDef.
  let modelDefs = toProviderModels(withAutoModel(kiroModels));
  const diskCached = readModelDiskCache();
  if (diskCached && diskCached.length > 0) {
    const cachedModels = withAutoModel(diskCached);
    setCachedDynamicModels(cachedModels);
    modelDefs = toProviderModels(cachedModels);
    log.info(`Loaded ${modelDefs.length} models from disk cache (fast path)`);
  }

  // Seed profileArn synchronously from stored credentials so streamKiro
  // never throws "profileArn not resolved" before the background refresh
  // completes. The background still resolves it via network if it's missing.
  const credsEager = readKiroCredentials();
  if (credsEager?.profileArn) {
    seedProfileArn(credsEager.profileArn);
    log.info(`Seeded profileArn from stored credentials: ${credsEager.profileArn}`);
  }

  // Register provider immediately — no awaiting network
  pi.registerProvider("kiro", {
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    api: "kiro-api",
    authHeader: true,
    models: modelDefs,
    oauth: {
      name: "Kiro (Builder ID / IAM Identity Center)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access as string,
      modifyModels: (allModels: Model<Api>[], cred: OAuthCredentials): Model<Api>[] => {
        const kc = cred as KiroCredentials;
        const apiRegion = resolveApiRegion(kc.region);
        const nonKiro = allModels.filter((m) => m.provider !== "kiro");

        // Re-seed profileArn after login/refresh so streamKiro can read it.
        if (kc.profileArn) {
          seedProfileArn(kc.profileArn);
        }

        // Stamp provider/api/baseUrl onto a ProviderModelConfig to produce a
        // concrete Model<Api>. `Api` and `Provider` are both `… | string`,
        // so "kiro-api"/"kiro" are assignable without a cast.
        const toKiroModel = (m: ProviderModelConfig): Model<Api> => ({
          ...m,
          api: "kiro-api",
          provider: "kiro",
          baseUrl: resolveRuntimeUrl(apiRegion),
        });

        const dynamicDefs = getCachedDynamicModels();
        const kiroModelsToRegister: Model<Api>[] =
          dynamicDefs && dynamicDefs.length > 0
            ? toProviderModels(withAutoModel(dynamicDefs)).map(toKiroModel)
            : filterModelsByRegion(toProviderModels(withAutoModel(kiroModels)).map(toKiroModel), apiRegion);

        return [...nonKiro, ...kiroModelsToRegister];
      },
    },
    streamSimple: streamKiro,
  });

  // --- Background refresh: token + models, non-blocking ---
  Promise.resolve().then(async () => {
    const creds = readKiroCredentials();
    if (!creds?.access && !creds?.refresh) {
      log.warn(
        "Run 'kiro login' to authenticate and fetch models dynamically. Note: This extension does not have the same authentication mechanism as other Kiro tools.",
      );
      return;
    }

    // Skip token refresh if not expired (with 5-min buffer)
    let accessToken = creds.access;
    const REFRESH_BUFFER_MS = 5 * 60 * 1000;
    const needsRefresh =
      creds.refresh && (!creds.expires || creds.expires - Date.now() < REFRESH_BUFFER_MS);
    if (needsRefresh) {
      try {
        log.info("Background: refreshing token…");
        const refreshed = await refreshKiroToken(creds);
        accessToken = refreshed.access;
        writeKiroCredentials(refreshed);
      } catch (err) {
        log.warn(`Background token refresh failed, using existing token: ${err}`);
      }
    }

    // Resolve profileArn if missing
    let profileArn = creds.profileArn;
    if (!profileArn && accessToken) {
      try {
        const apiRegion = resolveApiRegion(creds.region);
        log.info("Background: resolving profileArn…");
        profileArn = (await resolveProfileArn(accessToken, apiRegion)) ?? undefined;
        if (profileArn) {
          writeKiroCredentialsPartial({ profileArn });
        } else {
          log.warn("Background: could not resolve profileArn — model fetch skipped");
          return;
        }
      } catch (err) {
        log.warn(`Background: profileArn resolution failed: ${err}`);
        return;
      }
    }

    if (profileArn) {
      seedProfileArn(profileArn);
      // Skip model fetch if disk cache is still fresh
      if (diskCached && diskCached.length > 0) {
        log.info("Background: disk cache still fresh, skipping model fetch");
        return;
      }
      try {
        const apiRegion = resolveApiRegion(creds.region);
        log.info("Background: fetching models from Kiro API…");
        const apiModels = await fetchAvailableModels(accessToken, apiRegion, profileArn);
        const dynamicDefs = buildModelsFromApi(apiModels);
        setCachedDynamicModels(dynamicDefs);
        writeModelDiskCache(dynamicDefs);
        log.info(`Background: cached ${dynamicDefs.length} models to disk`);
      } catch (err) {
        log.warn(`Background: model fetch failed: ${err}`);
      }
    }
  }).catch((err: unknown) => log.warn(`Background refresh error: ${err}`));
}
