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
  resolveApiRegion,
  resolveProfileArn,
  resolveRuntimeUrl,
  setCachedDynamicModels,
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
  idleTimeout?: number;
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

/** Pi → Kiro effort mapping. Exposes all 5 Pi thinking levels. */
const KIRO_THINKING_LEVEL_MAP: Partial<Record<string, string | null>> = {
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "max",
};

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
    idleTimeout: d.idleTimeout,
    ...(d.reasoningHidden ? { reasoningHidden: d.reasoningHidden } : {}),
    ...(d.reasoning
      ? {
          thinkingLevelMap: KIRO_THINKING_LEVEL_MAP,
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
  // Fetch available models from Kiro API. Fallback to hardcoded list if fetch fails or no credentials.
  // `kiroModels` (KiroModel[]) is structurally a superset of KiroModelDef, so
  // it's directly assignable to `toProviderModels` without a cast.
  let modelDefs = toProviderModels(kiroModels);
  const creds = readKiroCredentials();
  if (creds?.access || creds?.refresh) {
    let accessToken = creds.access;

    // Always refresh at startup to guarantee a valid token
    if (creds.refresh) {
      try {
        log.info("Refreshing token at startup…");
        const refreshed = await refreshKiroToken(creds);
        accessToken = refreshed.access;
        writeKiroCredentials(refreshed);
      } catch (err) {
        log.warn(`Startup token refresh failed, trying with existing token: ${err}`);
      }
    }

    // Resolve profileArn if missing (Builder ID device-code flow never receives one)
    let profileArn = creds.profileArn;
    if (!profileArn && accessToken) {
      try {
        const apiRegion = resolveApiRegion(creds.region);
        log.info("profileArn missing, resolving via ListAvailableProfiles…");
        profileArn = await resolveProfileArn(accessToken, apiRegion) ?? undefined;
        if (profileArn) {
          log.info(`Resolved profileArn: ${profileArn}`);
          writeKiroCredentialsPartial({ profileArn });
        } else {
          log.warn("Could not resolve profileArn — model fetch and streaming will fail");
        }
      } catch (err) {
        log.warn(`profileArn resolution failed: ${err}`);
      }
    }

    if (profileArn) {
      seedProfileArn(profileArn);
      try {
        const apiRegion = resolveApiRegion(creds.region);
        const apiModels = await fetchAvailableModels(accessToken, apiRegion, profileArn);
        const dynamicDefs = buildModelsFromApi(apiModels);
        setCachedDynamicModels(dynamicDefs);
        modelDefs = toProviderModels(dynamicDefs);
        log.info(`Loaded ${modelDefs.length} models dynamically from Kiro API`);
      } catch (err) {
        log.warn(`Failed to fetch models at startup, using hardcoded fallback: ${err}`);
      }
    }
  } else {
    log.warn(
      "Run 'kiro login' to authenticate and fetch models dynamically. Note: This extension does not have the same authentication mechanism as other Kiro tools.",
    );
  }

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
            ? toProviderModels(dynamicDefs).map(toKiroModel)
            : filterModelsByRegion(toProviderModels(kiroModels).map(toKiroModel), apiRegion);

        return [...nonKiro, ...kiroModelsToRegister];
      },
    },
    streamSimple: streamKiro,
  });
}
