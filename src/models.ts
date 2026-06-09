import { resolveProfileArn } from "./stream.js";

// Kiro model catalog + ID conversion + region mapping.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file is in the pi/dash
// form except KIRO_MODEL_IDS and the output of resolveKiroModel.

/** Canonical Kiro API IDs (dot form) accepted by the server. */
export const KIRO_MODEL_IDS = new Set<string>([
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.5-1m",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "kimi-k2.5",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-4.7",
  "glm-4.7-flash",
  "qwen3-coder-next",
  "agi-nova-beta-1m",
  "qwen3-coder-480b",
  "auto",
]);

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6). */
export function dashToDot(modelId: string): string {
  return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

/** Convert Kiro API's dot form to pi's dash form (e.g. 4.6 → 4-6). */
export function dotToDash(modelId: string): string {
  return modelId.replace(/(\d)\.(\d)/g, "$1-$2");
}

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6). */
export function resolveKiroModel(modelId: string): string {
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  if (!KIRO_MODEL_IDS.has(kiroId)) {
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

/**
 * Models available per API region (allowlist). Unknown regions return an
 * empty list — update this map when Kiro launches in a new region.
 * Source: https://kiro.dev/docs/cli/models/
 */
const MODELS_BY_REGION: Record<string, Set<string>> = {
  "us-east-1": new Set([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-6-1m",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-1m",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-1m",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "deepseek-3-2",
    "kimi-k2-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-4-7",
    "glm-4-7-flash",
    "qwen3-coder-next",
    "qwen3-coder-480b",
    "agi-nova-beta-1m",
    "auto",
  ]),
  "eu-central-1": new Set([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "qwen3-coder-next",
    "auto",
  ]),
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

export interface KiroModel {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  input: Input;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

export const kiroModels: KiroModel[] = [
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
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportedEfforts: ["low", "medium", "high", "max"],
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
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6-1m",
    name: "Claude Sonnet 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportedEfforts: ["low", "medium", "high", "max"],
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
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5-1m",
    name: "Claude Sonnet 4.5 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
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
    id: "glm-4-7",
    name: "GLM 4.7",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7-flash",
    name: "GLM 4.7 Flash",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
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
    id: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "agi-nova-beta-1m",
    name: "AGI Nova Beta (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "auto",
    name: "Auto",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
];

// ---- Dynamic model resolution -----------------------------------------

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
 * Fetch the list of models actually available for this account from Kiro.
 * Filters out "auto" — it appears in ListAvailableModels but is rejected
 * by GenerateAssistantResponse with INVALID_MODEL_ID.
 */
export async function fetchAvailableModels(
  accessToken: string,
  apiRegion: string,
): Promise<KiroApiModel[]> {
  const runtimeUrl = `https://runtime.${apiRegion}.kiro.dev/`;
  const profileArn = await resolveProfileArn(accessToken, runtimeUrl);
  
  if (!profileArn) {
    throw new Error("Missing profileArn: cannot fetch available models.");
  }

  const url = `https://management.${apiRegion}.kiro.dev/ListAvailableModels?origin=KIRO_CLI&profileArn=${encodeURIComponent(profileArn)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "pi-kiro",
    },
  });
  if (!resp.ok) {
    throw new Error(`ListAvailableModels failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { models?: KiroApiModel[] };
  return (data.models ?? []).filter((m) => m.modelId !== "auto");
}

/** Model families known to support reasoning/thinking. */
const REASONING_FAMILIES = new Set([
  "claude-sonnet", "claude-opus",
  "deepseek", "kimi", "glm", "qwen", "agi-nova", "minimax"
]);

function isReasoningModel(dotId: string): boolean {
  for (const family of REASONING_FAMILIES) {
    if (dotId.startsWith(family)) return true;
  }
  return false;
}

/** First-token timeout for slow models (Claude Opus can take 2-3 minutes). */
function firstTokenTimeout(dotId: string): number {
  if (dotId.startsWith("claude-opus")) return 180_000;
  return 90_000;
}

export interface KiroModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  firstTokenTimeout?: number;
  reasoningHidden?: boolean;
  supportedEfforts?: string[];
  supportsThinkingConfig?: boolean;
}

/**
 * Build pi model definitions from the Kiro ListAvailableModels API response.
 * Adds any new model IDs dynamically to KIRO_MODEL_IDS so resolveKiroModel passes.
 */
export function buildModelsFromApi(apiModels: KiroApiModel[]): KiroModelDef[] {
  return apiModels.map((m) => {
    // Register the model ID dynamically to allow resolveKiroModel to pass
    KIRO_MODEL_IDS.add(m.modelId);

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
      firstTokenTimeout: firstTokenTimeout(m.modelId),
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
