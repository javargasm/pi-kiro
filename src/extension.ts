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
  resolveRuntimeUrl,
  setCachedDynamicModels,
  type KiroModelDef,
} from "./models";
import { loginKiro, refreshKiroToken, type KiroCredentials } from "./oauth";
import { streamKiro } from "./stream";
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

/** Pi → Kiro effort mapping. Exposes all 5 Pi thinking levels. */
const KIRO_THINKING_LEVEL_MAP: Partial<Record<string, string | null>> = {
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "max",
};

function toProviderModels(defs: KiroModelDef[]): ProviderModelConfig[] {
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
          thinkingLevelMap: KIRO_THINKING_LEVEL_MAP,
          compat: { forceAdaptiveThinking: true },
        }
      : {}),
  }));
}

/** Read kiro credentials from pi's auth.json if available. */
function readKiroCredentials(): { access: string; region: string } | null {
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

    return {
      access: kiro.access,
      region: (kiro.region as string) || "us-east-1",
    };
  } catch {
    return null;
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Fetch available models from Kiro API. Fallback to hardcoded list if fetch fails or no credentials.
  let modelDefs = toProviderModels(kiroModels as unknown as KiroModelDef[]);
  const creds = readKiroCredentials();
  if (creds) {
    try {
      const apiRegion = resolveApiRegion(creds.region);
      const apiModels = await fetchAvailableModels(creds.access, apiRegion);
      const dynamicDefs = buildModelsFromApi(apiModels);
      setCachedDynamicModels(dynamicDefs);
      modelDefs = toProviderModels(dynamicDefs);
      log.info(`Loaded ${modelDefs.length} models dynamically from Kiro API`);
    } catch (err) {
      log.warn(`Failed to fetch models at startup, using hardcoded fallback: ${err}`);
    }
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
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const nonKiro = allModels.filter((m) => m.provider !== "kiro");

        let kiroModelsToRegister: Model<Api>[];
        const dynamicDefs = getCachedDynamicModels();
        if (dynamicDefs && dynamicDefs.length > 0) {
          kiroModelsToRegister = toProviderModels(dynamicDefs).map((m) => ({
            ...m,
            provider: "kiro" as const,
            api: "kiro-api" as const,
            baseUrl: resolveRuntimeUrl(apiRegion),
          })) as unknown as Model<Api>[];
        } else {
          const fallbackDefs = toProviderModels(kiroModels as unknown as KiroModelDef[]);
          const kiroOnly = fallbackDefs.map((m) => ({
            ...m,
            provider: "kiro" as const,
            api: "kiro-api" as const,
            baseUrl: resolveRuntimeUrl(apiRegion),
          }));
          kiroModelsToRegister = filterModelsByRegion(kiroOnly, apiRegion) as unknown as Model<Api>[];
        }

        return [...nonKiro, ...kiroModelsToRegister];
      },
    },
    streamSimple: streamKiro,
  });
}
