
// Kiro model catalog + ID conversion + region mapping.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file is in the pi/dash
// form except KIRO_MODEL_IDS and the output of resolveKiroModel.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./debug";
import { kiroUserAgents } from "./kiro-defaults";

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6). */
export function dashToDot(modelId: string): string {
  return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

/** Convert Kiro API's dot form to pi's dash form (e.g. 4.6 → 4-6). */
export function dotToDash(modelId: string): string {
  return modelId.replace(/(\d)\.(\d)/g, "$1-$2");
}

/**
 * Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6).
 * Accepts the static catalog plus anything the dynamic catalog advertises
 * (live ListAvailableModels or the disk cache), so newly launched Kiro
 * models work without a code change.
 */
export function resolveKiroModel(modelId: string): string {
  const kiroId = dashToDot(modelId);
  if (!KIRO_MODEL_IDS.has(kiroId) && !getCachedDynamicModels()?.some((m) => m.id === modelId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}

/**
 * Map an SSO/OIDC region to the Kiro API region. The Kiro Q API is only
 * deployed in a subset of regions; tokens issued in e.g. eu-west-1 must be
 * sent to the eu-central-1 API endpoint.
 */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
  "ap-northeast-1": "us-east-1",
  "ap-northeast-2": "us-east-1",
  "ap-northeast-3": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-south-1": "us-east-1",
  "ap-east-1": "us-east-1",
  "ap-south-2": "us-east-1",
  "ap-southeast-3": "us-east-1",
  "ap-southeast-4": "us-east-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

/** Runtime endpoint per API region. Kiro CLI 2.5+ migrated from amazonaws.com to kiro.dev. */
const RUNTIME_ENDPOINTS: Record<string, string> = {
  "us-east-1": "https://runtime.us-east-1.kiro.dev",
  "eu-central-1": "https://runtime.eu-central-1.kiro.dev",
};

export function resolveRuntimeUrl(apiRegion: string): string {
  return RUNTIME_ENDPOINTS[apiRegion] ?? `https://runtime.${apiRegion}.kiro.dev`;
}

const BASE_URL = resolveRuntimeUrl("us-east-1");
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Fields every Kiro model shares. Spread into each literal below. */
const KIRO_DEFAULTS = {
  api: "kiro-api" as const,
  provider: "kiro" as const,
  baseUrl: BASE_URL,
  cost: ZERO_COST,
} as const;

type Input = ("text" | "image")[];
const MULTIMODAL: Input = ["text", "image"];
const TEXT_ONLY: Input = ["text"];

export interface KiroModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: Input;
  contextWindow: number;
  maxTokens: number;
  /** Optional per-model override for the first-token timeout (ms). */
  firstTokenTimeout?: number;
  /**
   * Upstream is expected to hide reasoning from clients — tags and
   * native reasoning events should be absent. When set:
   *
   *   - The `<thinking_mode>` system-prompt directive is skipped
   *     (the provider ignores it for these models).
   *   - A redacted-thinking breadcrumb is emitted lazily — only if
   *     no content or tool-call arrives within
   *     `HIDDEN_REASONING_COUNTDOWN_MS`. Fast responses emit no
   *     thinking block; slow responses get a single "Reasoning
   *     hidden by provider" marker so downstream UIs can surface
   *     "the model is deliberating" during the server-side wait.
   *
   * Does NOT gate the ThinkingTagParser — that runs unconditionally
   * when `reasoning` is enabled. The adaptive-thinking policy is
   * advisory: some models (Opus 4.7) intermittently leak
   * `<thinking>...</thinking>` tags inline, and the parser handles
   * them correctly when they do arrive.
   *
   * Applies to Claude Opus 4.7, which flipped Anthropic's
   * adaptive-thinking default from "summarized" to "omitted".
   * See https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
   */
  reasoningHidden?: boolean;
  /**
   * Effort levels supported by this model for adaptive thinking.
   * Sourced from `ListAvailableModels` → `additionalModelRequestFieldsSchema`.
   * When present, the effort is sent via `additionalModelRequestFields.output_config.effort`
   * in the GenerateAssistantResponse request body.
   */
  supportedEfforts?: string[];
  /** Whether the model supports `thinking` block configuration. */
  supportsThinkingConfig?: boolean;
}

/**
 * Pi → Kiro adaptive-thinking effort. Pi has 5 levels (minimal…xhigh), Kiro
 * has 5 (low…max); pi's extra bottom level means each maps one up.
 */
export const PI_TO_KIRO_EFFORT: Record<string, string> = {
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "max",
};

export interface KiroModel extends KiroModelDef {
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const kiroModels: KiroModel[] = [
  {
    ...KIRO_DEFAULTS,
    id: "claude-fable-5",
    name: "Claude Fable 5 (disabled)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    firstTokenTimeout: 90_000,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 196_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 196_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 256_000,
    maxTokens: 64_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 272_000,
    maxTokens: 64_000,
    firstTokenTimeout: 90_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 272_000,
    maxTokens: 64_000,
    firstTokenTimeout: 90_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 272_000,
    maxTokens: 64_000,
    firstTokenTimeout: 90_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "auto",
    name: "Auto",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
];

/** Canonical Kiro API IDs (dot form) of the static catalog. */
export const KIRO_MODEL_IDS = new Set(kiroModels.map((m) => dashToDot(m.id)));

/**
 * Static-catalog models per API region (fallback when the dynamic catalog is
 * unavailable). Unknown regions return an empty list — update this map when
 * Kiro launches in a new region. Source: https://kiro.dev/docs/cli/models/
 */
const STATIC_IDS = kiroModels.map((m) => m.id);
const MODELS_BY_REGION: Record<string, Set<string>> = {
  "us-east-1": new Set(STATIC_IDS),
  "eu-central-1": new Set(STATIC_IDS.filter((id) => id !== "deepseek-3-2")),
};

export function filterModelsByRegion<T extends { id: string }>(
  models: T[],
  apiRegion: string,
): T[] {
  const allowed = MODELS_BY_REGION[apiRegion];
  if (!allowed) {
    console.warn(
      `[pi-kiro] Unknown API region "${apiRegion}" — no models available. Update MODELS_BY_REGION in models.ts.`,
    );
    return [];
  }
  return models.filter((m) => allowed.has(m.id));
}

// ---- Dynamic model resolution -----------------------------------------

/** Captured management-API user agents (the real CLI reports os/macos here). */
const RUNTIME_UA = kiroUserAgents("codewhispererruntime", "macos");

export interface KiroApiModel {
  modelId: string;
  modelName: string;
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
  supportedInputTypes?: string[];
  /** Schema for extra fields accepted by GenerateAssistantResponse. */
  additionalModelRequestFieldsSchema?: {
    properties?: {
      output_config?: { properties?: { effort?: { enum?: string[] } } };
      thinking?: { properties?: { type?: { enum?: string[] } } };
    };
  };
}

/**
 * Resolve the Kiro profile ARN by calling ListAvailableProfiles.
 * Builder ID device-code login doesn't receive a profileArn, so we
 * discover it here. Returns null on failure (graceful fallback).
 */
export async function resolveProfileArn(
  accessToken: string,
  apiRegion: string,
): Promise<string | null> {
  const resp = await fetch(`https://management.${apiRegion}.kiro.dev/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
      "user-agent": RUNTIME_UA["user-agent"],
    },
    body: "{}",
  });
  if (!resp || !resp.ok) return null;

  const data = (await resp.json()) as {
    profiles?: { arn?: string; profileType?: string; status?: string }[];
  };
  const profiles = data.profiles ?? [];
  const kiroProfile = profiles.find((p) => p.profileType === "KIRO" && p.status === "ACTIVE");
  return kiroProfile?.arn ?? profiles[0]?.arn ?? null;
}

/**
 * Fetch the list of models actually available for this account from Kiro.
 */
export async function fetchAvailableModels(
  accessToken: string,
  apiRegion: string,
  profileArn: string,
): Promise<KiroApiModel[]> {

  const url = `https://management.${apiRegion}.kiro.dev/?origin=KIRO_CLI&profileArn=${encodeURIComponent(profileArn)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
      ...RUNTIME_UA,
      "x-amzn-codewhisperer-optout": "true",
      "amz-sdk-request": "attempt=1; max=3",
      "amz-sdk-invocation-id": crypto.randomUUID(),
      "accept": "*/*",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({ origin: "KIRO_CLI", profileArn }),
  });
  if (!resp || !resp.ok) {
    if (!resp) throw new Error("ListAvailableModels failed: fetch returned no response");
    const body = await resp.text().catch(() => "");
    if (resp.status === 401 || (resp.status === 400 && body.includes("Invalid token"))) {
      throw new Error(`Authentication failed: 401 ListAvailableModels failed - ${body}`);
    }
    throw new Error(`ListAvailableModels failed: HTTP ${resp.status} - ${body}`);
  }
  const data = (await resp.json()) as { models?: KiroApiModel[] };
  return data.models ?? [];
}

/** Model families known to support reasoning/thinking. */
const REASONING_FAMILIES = new Set([
  "claude-fable", "claude-sonnet", "claude-opus",
  "deepseek", "kimi", "glm", "qwen", "agi-nova", "minimax", "gpt",
]);

function isReasoningModel(dotId: string): boolean {
  for (const family of REASONING_FAMILIES) {
    if (dotId.startsWith(family)) return true;
  }
  return false;
}

/** Timeout for high-effort reasoning models (Opus/Fable: 180s). */
function modelTimeout(dotId: string, defaultMs: number): number {
  if (dotId.startsWith("claude-fable") || dotId.startsWith("claude-opus")) return 180_000;
  return defaultMs;
}

/** Build pi model definitions from the Kiro ListAvailableModels API response. */
export function buildModelsFromApi(apiModels: KiroApiModel[]): KiroModelDef[] {
  return apiModels.map((m) => {
    const dashId = dotToDash(m.modelId);
    const supportedTypes = m.supportedInputTypes ?? ["TEXT"];
    const input: ("text" | "image")[] = supportedTypes.includes("IMAGE")
      ? ["text", "image"]
      : ["text"];

    // Extract supported effort levels from the model schema
    const effortEnum = m.additionalModelRequestFieldsSchema
      ?.properties?.output_config?.properties?.effort?.enum;
    const supportedEfforts = Array.isArray(effortEnum) && effortEnum.length > 0
      ? effortEnum
      : undefined;

    const supportsThinkingConfig = !!m.additionalModelRequestFieldsSchema?.properties?.thinking;

    return {
      id: dashId,
      name: m.modelName,
      reasoning: isReasoningModel(m.modelId),
      input,
      contextWindow: m.tokenLimits?.maxInputTokens ?? 200_000,
      maxTokens: m.tokenLimits?.maxOutputTokens ?? 8_192,
      firstTokenTimeout: modelTimeout(m.modelId, 90_000),
      // Per-model overrides for known special cases
      ...(supportedEfforts ? { supportedEfforts } : {}),
      ...(supportsThinkingConfig ? { supportsThinkingConfig } : {}),
    };
  });
}

// Module-level cache for dynamically loaded models
let cachedDynamicModels: KiroModelDef[] | null = null;

export function getCachedDynamicModels(): KiroModelDef[] | null {
  return cachedDynamicModels;
}

export function setCachedDynamicModels(models: KiroModelDef[] | null): void {
  cachedDynamicModels = models;
}

// ---- Disk model cache -------------------------------------------------

const MODEL_DISK_CACHE_PATH = join(homedir(), ".pi", "agent", "kiro-models-cache.json");
const MODEL_DISK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Read models from disk cache. Returns null if missing, corrupt, or expired. */
export function readModelDiskCache(): KiroModelDef[] | null {
  try {
    if (!existsSync(MODEL_DISK_CACHE_PATH)) return null;
    const raw = readFileSync(MODEL_DISK_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { ts?: number; models?: KiroModelDef[] };
    if (!parsed || !Array.isArray(parsed.models) || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > MODEL_DISK_CACHE_TTL_MS) return null;
    return parsed.models;
  } catch {
    return null;
  }
}

/** Persist models to disk cache with a timestamp. */
export function writeModelDiskCache(models: KiroModelDef[]): void {
  try {
    const dir = dirname(MODEL_DISK_CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      MODEL_DISK_CACHE_PATH,
      JSON.stringify({ ts: Date.now(), models }),
      { mode: 0o600 },
    );
  } catch (err) {
    // Non-fatal — cache write failure degrades gracefully
    log.warn(`Failed to write model disk cache: ${err}`);
  }
}
