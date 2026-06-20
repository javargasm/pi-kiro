// Kiro streaming orchestrator. Builds the CodeWhisperer request, enforces
// retry/timeout policies, and translates Kiro's JSON event stream into pi's
// AssistantMessageEvent protocol.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { log, previewChunk } from "./debug";
import { parseKiroEvents } from "./event-parser";
import { isPermanentError } from "./health";
import type { KiroModel } from "./models";
import { createHash } from "node:crypto";
import { kiroModels, resolveKiroModel, getCachedDynamicModels } from "./models";
import { ThinkingTagParser } from "./thinking-parser";
import { countTokens } from "./tokenizer";

import {
  buildHistory,
  convertImagesToKiro,
  extractImages,
  getContentText,
  historyHasToolBlocks,
  KIRO_PLACEHOLDER_TOOL,
  type KiroEnvState,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  parseToolArgs,
  toKiroToolUseId,
  TOOL_RESULT_LIMIT,
  truncate,
} from "./transform";
import {
  COMPACTION_THRESHOLD_PCT,
  resolveOS,
  SYSTEM_SEED_ACK,
  SYSTEM_SEED_INSTRUCTION,
} from "./kiro-defaults";

// ---- Retry / timeout constants -----------------------------------------

const FIRST_TOKEN_TIMEOUT_DEFAULT_MS = 90_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;

const CAPACITY_MAX_RETRIES = 3;
const CAPACITY_BASE_DELAY_MS = 5_000;
const CAPACITY_MAX_DELAY_MS = 30_000;

const TRANSIENT_MAX_RETRIES = 3;
const TRANSIENT_BASE_DELAY_MS = 2_000;
const TRANSIENT_MAX_DELAY_MS = 15_000;

const CONTEXT_TRUNCATION_MAX_RETRIES = 3;
const CONTEXT_TRUNCATION_DROP_RATIO = 0.3;

const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long", "Improperly formed"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";

function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function isTooBigError(status: number, body: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => body.includes(p)));
}

function isNonRetryableBodyError(body: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => body.includes(p));
}

function isCapacityError(body: string): boolean {
  return body.includes(CAPACITY_PATTERN);
}

function isTransientError(status: number): boolean {
  return status === 429 || status >= 500;
}

export function firstTokenTimeoutForModel(modelId: string): number {
  const m =
    (kiroModels.find((x) => x.id === modelId) as KiroModel | undefined) ??
    getCachedDynamicModels()?.find((x) => x.id === modelId);
  return m?.firstTokenTimeout ?? FIRST_TOKEN_TIMEOUT_DEFAULT_MS;
}

function idleTimeoutForModel(modelId: string): number {
  const m = kiroModels.find((x) => x.id === modelId) as KiroModel | undefined;
  return m?.idleTimeout ?? IDLE_TIMEOUT_MS;
}

/**
 * Map Kiro's authoritative metadataEvent stopReason (real wire values:
 * TOOL_USE / END_TURN / MAX_TOKENS, occasionally STOP_SEQUENCE) onto the
 * internal stop reason. Returns null for unknown/absent values so the caller
 * can fall back to heuristics.
 */
export function mapKiroStopReason(raw: string | null | undefined): "stop" | "length" | "toolUse" | null {
  switch (raw?.toUpperCase()) {
    case "TOOL_USE":
      return "toolUse";
    case "MAX_TOKENS":
      return "length";
    case "END_TURN":
    case "STOP_SEQUENCE":
    case "COMPLETE":
    case "FINISHED":
      return "stop";
    default:
      return null;
  }
}

/**
 * Placeholder surfaced to downstream UIs during the deliberation window
 * on models that hide reasoning (e.g. Claude Opus 4.7 with
 * adaptive-thinking `display: "omitted"`). Emitted as a `thinking_delta`
 * only after the countdown elapses without any real output — fast
 * responses produce no delta at all. Clients drop the block at
 * `thinking_end` either via the empty-text predicate (zero-delta fast
 * path) or via a known-placeholder predicate (slow path).
 */
const HIDDEN_REASONING_PLACEHOLDER = "Reasoning hidden by provider";

/**
 * How long to wait after `start` before emitting the lazy
 * hidden-reasoning breadcrumb. Short enough that the marker appears
 * exactly when a wait starts feeling palpable, long enough that fast
 * responses never flash it. Content / tool-call events cancel the
 * timer, so the breadcrumb only fires when nothing else arrives in
 * time.
 */
export const HIDDEN_REASONING_COUNTDOWN_MS = 2000;

/**
 * Emit a complete hidden-reasoning breadcrumb as a single flush:
 * `thinking_start` + `thinking_delta(marker)` + `thinking_end`. The
 * block carries `redacted: true` so downstream UIs can drop it by
 * placeholder or marker predicate — Inkstone drops it via its
 * `REDACTED_THINKING_PLACEHOLDERS` filter.
 *
 * Called only from the slow-path countdown timer: content and tool
 * events cancel the timer so this never fires when real output
 * arrived in time.
 */
function emitHiddenReasoningLate(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentIndex = output.content.length;
	const block: ThinkingContent = {
		type: "thinking",
		thinking: HIDDEN_REASONING_PLACEHOLDER,
		redacted: true,
	};
	output.content.push(block);
	stream.push({ type: "thinking_start", contentIndex, partial: output });
	stream.push({
		type: "thinking_delta",
		contentIndex,
		delta: HIDDEN_REASONING_PLACEHOLDER,
		partial: output,
	});
	stream.push({
		type: "thinking_end",
		contentIndex,
		content: "",
		partial: output,
	});
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// ---- profileArn store ---------------------------------------------------
// The profileArn is sourced from Kiro CLI's local auth storage (SQLite DB
// or SSO cache) and seeded into this in-memory store at startup or after
// login/refresh. No API call is made to discover it.

let profileArnStore: string | undefined = undefined;

/** Clear the store. Tests call this in beforeEach. */
export function resetProfileArnCache(): void {
  profileArnStore = undefined;
}

/** Seed the profileArn. Called from extension.ts at startup and after login/refresh. */
export function seedProfileArn(arn: string): void {
  profileArnStore = arn;
}

/** Read the cached profileArn. */
export function getProfileArn(): string | undefined {
  return profileArnStore;
}

// ---- Request body shape ------------------------------------------------

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn: string;
  agentMode?: string;
  additionalModelRequestFields?: {
    output_config?: { effort?: string };
    thinking?: { type: "adaptive" | "disabled"; display?: "summarized" | "omitted" };
    max_tokens?: number;
  };
}

interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

function emitToolCall(
  state: KiroToolCallState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): boolean {
  if (!state.input.trim()) state.input = "{}";

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(state.input) as Record<string, unknown>;
    if (args && typeof args === "object" && "__tool_use_purpose" in args) {
      delete args.__tool_use_purpose;
    }
  } catch (e) {
    log.warn(
      `failed to parse tool input for "${state.name}" (${state.toolUseId}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }

  const contentIndex = output.content.length;
  const toolCall: ToolCall = { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  return true;
}

// ---- conversationId stability -----------------------------------------

/**
 * The real Kiro CLI keeps ONE `conversationId` for an entire session — every
 * turn of a conversation reuses the same id, and it stays the same even after
 * the CLI is restarted and the session is resumed.
 *
 * We reproduce both properties by deriving the conversationId DETERMINISTICALLY
 * from pi's stable per-conversation session key (options.sessionId). A random
 * UUID would reset every time the process restarts, minting a brand-new
 * conversationId mid-conversation.
 *
 * The value is a v5-style (name-based) UUID: pure function of the key, so the
 * same conversation always maps to the same id across process restarts, with
 * no shared mutable state. Requests with no session key fall back to a random
 * one-off UUID.
 */
const CONVERSATION_ID_NAMESPACE = "pi-kiro/conversation";

function deterministicConversationId(key: string): string {
  // SHA-1 over namespace + key, first 16 bytes, with RFC-4122 version (5) and
  // variant bits set — a valid, stable name-based UUID.
  const digest = createHash("sha1").update(`${CONVERSATION_ID_NAMESPACE}\u0000${key}`).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function resolveConversationId(sessionId: string | undefined): string {
  if (!sessionId) return crypto.randomUUID();
  return deterministicConversationId(sessionId);
}

// ---- Main entry --------------------------------------------------------

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Hidden-reasoning breadcrumb timer. Armed on `start` (for
    // `reasoningHidden` models), cancelled as soon as any content or
    // tool-call event arrives. If the timer fires before anything
    // else, `emitHiddenReasoningLate` pushes a complete shim block
    // in one flush. Hoisted above the try/catch so the terminal
    // error path can cancel it, preventing a stray late shim from
    // firing after the stream ended.
    let hiddenShimTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error("Kiro credentials not set. Run /login kiro.");
      }

      const endpoint = model.baseUrl || "https://runtime.us-east-1.kiro.dev";
      const profileArn = getProfileArn();
      if (!profileArn) {
        throw new Error(
          "profileArn not resolved. Re-run /login kiro to refresh credentials.",
        );
      }
      const kiroModelId = resolveKiroModel(model.id);
      const thinkingEnabled = !!options?.reasoning || model.reasoning;
      // Kiro models where upstream hides reasoning entirely (no `<thinking>`
      // tags in the text stream, no native reasoning event). We surface a
      // redacted ThinkingContent shim so downstream UIs can show a
      // "reasoning hidden" marker via the standard pi-ai contract.
      const reasoningHidden = !!(model as KiroModel).reasoningHidden;

      log.debug("request.init", {
        endpoint,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        thinkingEnabled,
        reasoningHidden,
        reasoning: options?.reasoning,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        profileArn,
        sessionId: options?.sessionId,
      });

      let systemPrompt = context.systemPrompt ?? "";
      // Skip the `<thinking_mode>` directive when the provider hides
      // reasoning — the directive is a no-op there and costs prompt tokens.
      if (thinkingEnabled && !reasoningHidden) {
        const budget =
          options?.reasoning === "xhigh"
            ? 50000
            : options?.reasoning === "high"
              ? 30000
              : options?.reasoning === "medium"
                ? 20000
                : 10000;
        systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${
          systemPrompt ? `\n${systemPrompt}` : ""
        }`;
      }

      // Build envState from the host process (matches real Kiro CLI).
      const envState: KiroEnvState = {
        operatingSystem: resolveOS(),
        currentWorkingDirectory: process.cwd(),
      };

      // Stable per-session conversationId (matches Kiro CLI: one id for the
      // whole session). Falls back to a fresh UUID only when no sessionId is
      // available. Computed ONCE here so retries of this turn — and every
      // later turn of the same conversation — reuse the same id.
      const conversationId = resolveConversationId(options?.sessionId);
      let retryCount = 0;

      while (retryCount <= MAX_RETRIES) {
        if (options?.signal?.aborted) throw options.signal.reason;

        const normalized = normalizeMessages(context.messages);
        // NOTE: systemPrompt is NOT passed to buildHistory. It contains the
        // <thinking_mode>enabled</thinking_mode> directive which, when replayed
        // in history, causes Bedrock to expect a reasoningContent.signature on
        // the following assistant response — triggering THINKING_SIGNATURE_INVALID.
        // The thinking directive only belongs in the current message (or seed).
        const {
          history,
          systemPrepended: _systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId);

        // Inject the synthetic system seed pair at the start of history.
        // The real Kiro CLI always sends this as the first history entries.
        const seedInstruction = SYSTEM_SEED_INSTRUCTION.replace("{{modelId}}", kiroModelId);
        const seedPair: KiroHistoryEntry[] = [
          { userInputMessage: { content: seedInstruction, origin: "KIRO_CLI" } },
          { assistantResponseMessage: { content: SYSTEM_SEED_ACK } },
        ];
        history.unshift(...seedPair);

        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
        let currentImages: KiroImage[] | undefined;

        if (firstMsg?.role === "assistant") {
          const am = firstMsg;
          let armContent = "";
          let armReasoningText = "";
          let armReasoningSignature = "";
          const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
          if (Array.isArray(am.content)) {
            for (const b of am.content) {
              if (b.type === "text") {
                armContent += (b as TextContent).text;
              } else if (b.type === "thinking") {
                // Accumulate thinking text + signature for the reasoningContent field.
                const tb = b as unknown as { thinking: string; thinkingSignature?: string };
                armReasoningText += tb.thinking;
                if (tb.thinkingSignature) armReasoningSignature = tb.thinkingSignature;
              } else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: toKiroToolUseId(tc.id),
                  input: parseToolArgs(tc.arguments),
                });
              }
            }
          }
          const hasReasoning = armReasoningText.length > 0;
          if (armContent || armToolUses.length > 0 || hasReasoning) {
            const last = history[history.length - 1];
            // Only include reasoningContent when we have a valid signature.
            const reasoningContent = hasReasoning && armReasoningSignature
              ? { reasoningText: { text: armReasoningText, signature: armReasoningSignature } }
              : undefined;
            if (last && !last.userInputMessage && last.assistantResponseMessage) {
              last.assistantResponseMessage.content += `\n\n${armContent}`;
              if (armToolUses.length > 0) {
                last.assistantResponseMessage.toolUses = [
                  ...(last.assistantResponseMessage.toolUses ?? []),
                  ...armToolUses,
                ];
              }
              if (reasoningContent) {
                last.assistantResponseMessage.reasoningContent = reasoningContent;
              }
            } else {
              history.push({
                assistantResponseMessage: {
                  content: armContent,
                  ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                  ...(reasoningContent ? { reasoningContent } : {}),
                },
              });
            }
          }

          const toolResultImages: ImageContent[] = [];
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
                status: trm.isError ? "error" : "success",
                toolUseId: toKiroToolUseId(trm.toolCallId),
              });
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const { images: converted, omitted } = convertImagesToKiro(toolResultImages);
            if (omitted > 0) log.warn(`${omitted} tool-result image(s) omitted (size/count limit)`);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages: ImageContent[] = [];
          for (const m of currentMessages) {
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
                status: trm.isError ? "error" : "success",
                toolUseId: toKiroToolUseId(trm.toolCallId),
              });
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const { images: converted, omitted } = convertImagesToKiro(toolResultImages);
            if (omitted > 0) log.warn(`${omitted} tool-result image(s) omitted (size/count limit)`);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (systemPrompt) {
            currentContent = `${systemPrompt}\n\n${currentContent}`;
          }
        }

        // Wrap content in the Kiro CLI format: context entry + user message.
        const now = new Date();
        const tzOffset = -now.getTimezoneOffset();
        const tzSign = tzOffset >= 0 ? "+" : "-";
        const tzH = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
        const tzM = String(Math.abs(tzOffset) % 60).padStart(2, "0");
        const isoLocal = now.getFullYear() + "-" +
          String(now.getMonth() + 1).padStart(2, "0") + "-" +
          String(now.getDate()).padStart(2, "0") + "T" +
          String(now.getHours()).padStart(2, "0") + ":" +
          String(now.getMinutes()).padStart(2, "0") + ":" +
          String(now.getSeconds()).padStart(2, "0") + "." +
          String(now.getMilliseconds()).padStart(3, "0") +
          tzSign + tzH + ":" + tzM;
        const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
        currentContent =
          `--- CONTEXT ENTRY BEGIN ---\n` +
          `Current time: ${weekday}, ${isoLocal}\n` +
          `--- CONTEXT ENTRY END ---\n\n` +
          `--- USER MESSAGE BEGIN ---\n` +
          `${currentContent}\n` +
          `--- USER MESSAGE END ---`;

        // Always include envState in userInputMessageContext (real client does).
        let uimc: { envState: KiroEnvState; toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } = {
          envState,
        };
        if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
        if (context.tools?.length) {
          const ALLOWED_SCHEMA_KEYS = new Set([
            "type", "properties", "required", "description", "enum",
            "items", "default", "oneOf", "anyOf", "allOf",
            "minimum", "maximum", "minLength", "maxLength",
            "minItems", "maxItems", "pattern", "const", "title",
            "additionalProperties",
          ]);

          const sanitizeSchema = (obj: unknown): unknown => {
            if (obj === null || obj === undefined) return obj;
            if (Array.isArray(obj)) return obj.map(sanitizeSchema);
            if (typeof obj !== "object") return obj;

            const result: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
              if (!ALLOWED_SCHEMA_KEYS.has(key) && key !== "__tool_use_purpose") continue;
              if (key === "required" && Array.isArray(value) && value.length === 0) continue;
              if ((key === "minimum" || key === "maximum") && typeof value === "number") {
                if (Math.abs(value) > 1_000_000_000) continue;
              }
              // properties: las claves son nombres de parámetros, NO keywords — preservarlas
              if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
                const props: Record<string, unknown> = {};
                for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
                  props[name] = sanitizeSchema(sub);
                }
                result[key] = props;
                continue;
              }
              result[key] = sanitizeSchema(value);
            }
            return result;
          };

          uimc.tools = context.tools.map((t) => {
            const params = sanitizeSchema(t.parameters) as Record<string, unknown>;
            // Bedrock / Amazon Q often expects __tool_use_purpose in properties.
            // We'll inject it just in case it's a hard requirement, though it might not be.
            if (params.properties && typeof params.properties === "object" && !Array.isArray(params.properties)) {
              (params.properties as Record<string, unknown>).__tool_use_purpose = {
                type: "string",
                description: "A brief explanation why you are making this tool use.",
              };
            }
            return {
              toolSpecification: {
                name: t.name,
                description: t.description || `Use ${t.name}`,
                inputSchema: { json: params as Record<string, unknown> },
              },
            };
          });
        } else if (historyHasToolBlocks(history) || currentToolResults.length > 0) {
          // Bedrock rejects a request with TOOL_CONFIG_MISSING when the
          // conversation contains toolUse/toolResult blocks but no toolConfig
          // is defined. pi sends auxiliary turns (title generation,
          // summarization, compaction) WITHOUT tools, yet the replayed history
          // still carries tool blocks from earlier turns — so the request 400s
          // and retries identically in a loop. When tool blocks are present but
          // no tools were supplied, inject a minimal placeholder tool so
          // toolConfig exists. The model won't call it on these auxiliary turns.
          uimc.tools = [KIRO_PLACEHOLDER_TOOL];
        }

        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) {
            const { images: converted, omitted } = convertImagesToKiro(imgs);
            if (omitted > 0) log.warn(`${omitted} user image(s) omitted (size/count limit)`);
            currentImages = converted;
          }
        }

        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: currentContent,
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                userInputMessageContext: uimc,
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          profileArn,
          agentMode: "vibe",
        };

        // Attach adaptive thinking effort when the model supports it.
        // Pi has 5 levels (minimal…xhigh), Kiro has 5 (low…max).
        // Pi's extra bottom level (`minimal`) means each maps one up.
        const EFFORT_MAP: Record<string, string> = {
          minimal: "low",
          low: "medium",
          medium: "high",
          high: "xhigh",
          xhigh: "max",
        };
        const staticModel = kiroModels.find((m) => m.id === model.id) as KiroModel | undefined;
        const dynamicModel = getCachedDynamicModels()?.find((m) => m.id === model.id);
        const supportedEfforts = staticModel?.supportedEfforts ?? dynamicModel?.supportedEfforts;
        const supportsThinkingConfig = staticModel?.supportsThinkingConfig ?? dynamicModel?.supportsThinkingConfig;
        
        if (supportedEfforts && supportedEfforts.length > 0 && options?.reasoning && typeof options.reasoning === "string") {
          const kiroEffort = EFFORT_MAP[options.reasoning];
          if (kiroEffort && supportedEfforts.includes(kiroEffort)) {
            request.additionalModelRequestFields = request.additionalModelRequestFields || {};
            request.additionalModelRequestFields.output_config = { effort: kiroEffort };
            log.debug("effort.set", { piReasoning: options.reasoning, kiroEffort, model: model.id });
          }
        }

        // Request the adaptive thinking block so that Kiro streams the reasoning text.
        if (supportsThinkingConfig && thinkingEnabled) {
          request.additionalModelRequestFields = request.additionalModelRequestFields || {};
          request.additionalModelRequestFields.thinking = {
            type: "adaptive",
            display: "summarized",
          };
          log.debug("thinking.set", { type: "adaptive", display: "summarized", model: model.id });
        }

        // Forward max_tokens, but ONLY for models that advertise a thinking
        // config schema — those are the same models whose
        // additionalModelRequestFieldsSchema includes a `max_tokens` field, so
        // they accept the object. Sending it to models without that schema
        // risks an "Improperly formed request". Clamp to the schema bounds
        // (min 1024) and the model's own output window.
        if (supportsThinkingConfig && typeof options?.maxTokens === "number" && options.maxTokens > 0) {
          const capped = Math.min(
            Math.max(Math.floor(options.maxTokens), 1024),
            model.maxTokens || 64_000,
          );
          request.additionalModelRequestFields = request.additionalModelRequestFields || {};
          request.additionalModelRequestFields.max_tokens = capped;
          log.debug("maxTokens.set", { maxTokens: capped, model: model.id });
        }

        // -- HTTP request with capacity-retry inner loop -----------------
        // Emit `start` and arm the hidden-reasoning countdown. The
        // shim is deferred: if content or a tool call arrives within
        // HIDDEN_REASONING_COUNTDOWN_MS, the timer is cancelled and
        // no shim is emitted. If nothing arrives in time, the timer
        // fires a complete shim (start + delta + end) in one flush.
        // This covers the 25-30s server-side deliberation window on
        // Claude 4.7 without polluting fast responses with an empty
        // thinking block.
        stream.push({ type: "start", partial: output });
        if (reasoningHidden && thinkingEnabled && hiddenShimTimer === null) {
          hiddenShimTimer = setTimeout(() => {
            hiddenShimTimer = null;
            emitHiddenReasoningLate(output, stream);
          }, HIDDEN_REASONING_COUNTDOWN_MS);
        }

        let response!: Response;
        let capacityRetryCount = 0;
        let transientRetryCount = 0;
        let contextTruncationAttempt = 0;
        while (true) {
          const osName = resolveOS();
          const ua = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${osName} lang/rust/1.92.0 md/appVersion-2.8.1 app/AmazonQ-For-CLI`;
          const xAmzUa = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${osName} lang/rust/1.92.0 m/F app/AmazonQ-For-CLI`;
          const requestBody = JSON.stringify(request);

          log.debug("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
            requestJsonChars: requestBody.length,
          });

          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-amz-json-1.0",
              Accept: "*/*",
              "Accept-Encoding": "gzip",
              Authorization: `Bearer ${accessToken}`,
              "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
              "x-amzn-codewhisperer-optout": "true",
              "amz-sdk-invocation-id": crypto.randomUUID(),
              "amz-sdk-request": "attempt=1; max=3",
              "user-agent": ua,
              "x-amz-user-agent": xAmzUa,
              Pragma: "no-cache",
              "Cache-Control": "no-cache",
            },
            body: requestBody,
            signal: options?.signal,
          });

          if (response.ok) break;

          let errText = "";
          try {
            errText = await response.text();
          } catch {
            errText = "";
          }
          log.debug("response.error", {
            status: response.status,
            body: errText,
          });

          if (isCapacityError(errText) && capacityRetryCount < CAPACITY_MAX_RETRIES) {
            capacityRetryCount++;
            const delayMs = exponentialBackoff(
              capacityRetryCount - 1,
              CAPACITY_BASE_DELAY_MS,
              CAPACITY_MAX_DELAY_MS,
            );
            log.warn(
              `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${CAPACITY_MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, options?.signal);
            continue;
          }

          if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
            throw new Error(`Kiro API error: ${errText || response.statusText}`);
          }
          if (isTooBigError(response.status, errText)) {
            if (contextTruncationAttempt < CONTEXT_TRUNCATION_MAX_RETRIES && history.length > 0) {
              contextTruncationAttempt++;
              const dropCount = Math.max(1, Math.floor(history.length * CONTEXT_TRUNCATION_DROP_RATIO));
              const before = history.length;
              history.splice(0, dropCount);
              log.warn(
                `context too large — truncated history from ${before} to ${history.length} entries ` +
                `(attempt ${contextTruncationAttempt}/${CONTEXT_TRUNCATION_MAX_RETRIES})`,
              );
              // Rebuild request with truncated history and retry
              request.conversationState.history = history.length > 0 ? history : undefined;
              continue;
            }
            throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
          }
          if (isTransientError(response.status) && transientRetryCount < TRANSIENT_MAX_RETRIES) {
            transientRetryCount++;
            const jitter = Math.floor(Math.random() * 1000);
            const delayMs = exponentialBackoff(
              transientRetryCount - 1,
              TRANSIENT_BASE_DELAY_MS,
              TRANSIENT_MAX_DELAY_MS,
            ) + jitter;
            log.warn(
              `transient error ${response.status} — retrying in ${delayMs}ms ` +
              `(${transientRetryCount}/${TRANSIENT_MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          if (response.status === 401) {
            const permanent = isPermanentError(errText);
            if (permanent) {
              throw new Error(
                `Kiro API error: credentials permanently invalid — run /login kiro to re-authenticate. ${errText}`,
              );
            }
            // Non-permanent 401 falls through to the generic throw below
          }
          if (response.status === 403) {
            throw new Error(
              `Kiro API error: access token rejected (403) — run /login kiro to re-authenticate. ${errText}`,
            );
          }
          throw new Error(`Kiro API error: ${response.status} ${response.statusText} ${errText}`);
        }

        if (capacityRetryCount > 0) {
          log.info(`recovered from capacity pressure after ${capacityRetryCount} retries`);
        }
        if (transientRetryCount > 0) {
          log.info(`recovered from transient error after ${transientRetryCount} retries`);
        }
        if (contextTruncationAttempt > 0) {
          log.info(`recovered after ${contextTruncationAttempt} context truncation(s)`);
        }

        // -- Consume response stream -------------------------------------
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let receivedContextUsage = false;
        let serverStopReason: string | null = null;
        let chunkSeq = 0;
        let eventSeq = 0;

        // ThinkingTagParser runs unconditionally when thinking is
        // enabled. Defensive against providers that intermittently
        // leak `<thinking>...</thinking>` tags despite declaring
        // `reasoningHidden` (Claude Opus 4.7's adaptive-thinking
        // policy is advisory, not binding).
        const thinkingParser = thinkingEnabled
          ? new ThinkingTagParser(output, stream)
          : null;
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        let currentToolCall: KiroToolCallState | null = null;
        const flushToolCall = () => {
          if (!currentToolCall) return;
          if (emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
          currentToolCall = null;
        };

        /**
         * Cancel the hidden-reasoning countdown timer. Called on the
         * first content / tool-call event so the shim is suppressed
         * when real output arrives in time. No-op once the timer
         * has already fired (the shim is self-contained and complete
         * by then, or was never armed for non-reasoningHidden models).
         */
        const cancelHiddenShim = () => {
          if (hiddenShimTimer) {
            clearTimeout(hiddenShimTimer);
            hiddenShimTimer = null;
          }
        };

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleCancelled = false;
        const idleTimeoutMs = idleTimeoutForModel(model.id);
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void reader.cancel().catch(() => {});
          }, idleTimeoutMs);
        };

        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let streamError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");
        type ReadResult = { done: boolean; value?: Uint8Array };

        while (true) {
          let readResult: ReadResult;
          if (!gotFirstToken) {
            const readPromise = reader.read() as Promise<ReadResult>;
            let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
            const result = await Promise.race([
              readPromise,
              new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) => {
                firstTokenTimer = setTimeout(
                  () => resolve(FIRST_TOKEN_SENTINEL),
                  firstTokenTimeoutForModel(model.id),
                );
              }),
            ]);
            // Always clear the timer — otherwise the happy path keeps the
            // event loop alive for firstTokenTimeout ms after the stream
            // ends, which for opus-4-7 (180s) is user-visible as a hang
            // before a short-lived CLI exits.
            if (firstTokenTimer) clearTimeout(firstTokenTimer);
            if (result === FIRST_TOKEN_SENTINEL) {
              readPromise.catch(() => {});
              void reader.cancel().catch(() => {});
              firstTokenTimedOut = true;
              break;
            }
            readResult = result as ReadResult;
            gotFirstToken = true;
            resetIdle();
          } else {
            readResult = (await reader.read()) as ReadResult;
          }

          const { done, value } = readResult;
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
          if (log.isDebug()) {
            log.debug("stream.chunk", {
              seq: chunkSeq++,
              bytes: value?.byteLength ?? 0,
              decodedLen: decoded.length,
              // Printable preview of the decoded chunk — control chars shown as \xNN.
              preview: previewChunk(decoded),
            });
          }
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;

          // Only reset the idle timer when real events arrive — raw byte
          // reads (keepalive framing, partial chunks) must NOT prevent the
          // idle timeout from firing. Without this guard, the API's
          // keepalive framing resets the timer on every chunk, causing
          // potentially infinite stream hangs.
          if (events.length > 0) resetIdle();

          if (log.isDebug() && events.length > 0) {
            for (const ev of events) {
              log.debug("stream.event", { seq: eventSeq++, event: ev });
            }
          }

          for (const event of events) {
            switch (event.type) {
              case "contextUsage": {
                const pct = event.data.contextUsagePercentage;
                // Force overflow detection when context nears capacity.
                // Pi's isContextOverflow() triggers compaction when
                // usage.input > contextWindow.
                output.usage.input = pct >= COMPACTION_THRESHOLD_PCT
                  ? model.contextWindow + 1
                  : Math.round((pct / 100) * model.contextWindow);
                receivedContextUsage = true;
                log.debug("contextUsage", { pct, threshold: COMPACTION_THRESHOLD_PCT, willCompact: pct >= COMPACTION_THRESHOLD_PCT });
                break;
              }
              case "reasoning": {
                // Native reasoning event from Kiro (Opus 4.7+).
                // Accumulate chunks into a single Pi thinking block.
                cancelHiddenShim();
                const lastIsThinking =
                  output.content.length > 0 &&
                  output.content[output.content.length - 1]?.type === "thinking";
                // A signature-only frame (no reasoning text) with no open
                // thinking block has nothing to attach to — skip it instead of
                // emitting a stray empty thinking block.
                if (!event.data.text && !lastIsThinking) break;
                if (!lastIsThinking) {
                  output.content.push({ type: "thinking", thinking: "" });
                  stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                }
                const contentIndex = output.content.length - 1;
                const tc = output.content[contentIndex] as ThinkingContent;
                if (event.data.text) {
                  tc.thinking += event.data.text;
                  stream.push({ type: "thinking_delta", contentIndex, delta: event.data.text, partial: output });
                }
                if (event.data.signature) {
                  tc.thinkingSignature = event.data.signature;
                  // Signature indicates the end of the reasoning block.
                  // Pi engine automatically handles the final state.
                }
                break;
              }
              case "content": {
                // NOTE: do NOT dedup identical consecutive content frames.
                // The event parser consumes the buffer without re-emitting, so
                // identical back-to-back chunks ("\n\n", repeated indentation,
                // repeated tokens in generated code) are legitimate model
                // output and must be preserved, not silently dropped.
                totalContent += event.data;
                // Cancel the deferred shim — real content arrived in
                // time, no breadcrumb needed.
                cancelHiddenShim();
                if (thinkingParser) {
                  thinkingParser.processChunk(event.data);
                } else {
                  if (textBlockIndex === null) {
                    textBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                  }
                  const block = output.content[textBlockIndex] as TextContent | undefined;
                  if (block) {
                    block.text += event.data;
                    stream.push({
                      type: "text_delta",
                      contentIndex: textBlockIndex,
                      delta: event.data,
                      partial: output,
                    });
                  }
                }
                break;
              }
              case "toolUse": {
                const tc = event.data;
                // Cancel the deferred shim — a tool call arrived in
                // time, no breadcrumb needed.
                cancelHiddenShim();
                sawAnyToolCalls = true;
                if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                  flushToolCall();
                  currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
                }
                currentToolCall.input += tc.input || "";
                if (tc.input) totalContent += tc.input;
                if (tc.stop) flushToolCall();
                break;
              }
              case "toolUseInput": {
                if (currentToolCall) currentToolCall.input += event.data.input || "";
                if (event.data.input) totalContent += event.data.input;
                break;
              }
              case "toolUseStop": {
                if (event.data.stop) flushToolCall();
                break;
              }
              case "usage": {
                usageEvent = event.data;
                break;
              }
              case "metadata": {
                // Authoritative stop reason from Kiro's metadataEvent.
                if (event.data.stopReason) serverStopReason = event.data.stopReason;
                break;
              }
              case "error": {
                streamError = event.data.message
                  ? `${event.data.error}: ${event.data.message}`
                  : event.data.error;
                void reader.cancel().catch(() => {});
                break;
              }
            }
            if (streamError) break;
          }
        }

        if (idleTimer) clearTimeout(idleTimer);

        if (firstTokenTimedOut || idleCancelled || streamError) {
          // Once any output reached the consumer, a reset-and-retry would
          // DUPLICATE it: stream deltas already sent can't be retracted. Only a
          // first-token timeout is guaranteed to have produced nothing, so it's
          // the only case where reset+retry is always safe.
          const alreadyStreamed = totalContent.length > 0 || emittedToolCalls > 0;
          if (!alreadyStreamed && retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            log.warn(
              `stream ${firstTokenTimedOut ? "first-token timed out" : idleCancelled ? "idle timed out" : `error: ${streamError}`} — retrying (${retryCount}/${MAX_RETRIES})`,
            );
            // Cancel the pending shim BEFORE the backoff delay so
            // the timer can't fire mid-wait (exponential backoff
            // compounds to multi-second delays, easily exceeding
            // HIDDEN_REASONING_COUNTDOWN_MS). The retry re-arms a
            // fresh timer on the next `start`.
            cancelHiddenShim();
            await abortableDelay(delayMs, options?.signal);
            // Safe to reset — nothing was emitted to the consumer yet.
            output.content = [];
            textBlockIndex = null;
            continue;
          }
          // Either we already streamed partial output (can't retract) or we're
          // out of retries.
          if (streamError) {
            // Surface the error. With partial content already streamed, the
            // consumer sees the partial output followed by the error — better
            // than silently truncating or duplicating.
            throw new Error(
              `Kiro API stream error${alreadyStreamed ? " after partial output" : " after max retries"}: ${streamError}`,
            );
          }
          if (!alreadyStreamed) {
            throw new Error(
              `Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`,
            );
          }
          // Timeout AFTER partial output: finalize gracefully with what we have
          // instead of duplicating via a reset+retry. Fall through to finalize.
          log.info(
            `stream ${firstTokenTimedOut ? "first-token" : "idle"} timeout after partial output — finalizing with partial content`,
          );
        }

        // Stream ended cleanly. Cancel the deferred shim — either
        // content/tool calls already cancelled it, or nothing arrived
        // and the timer may still be pending (below-threshold
        // response). Either way, we don't want a late shim to fire
        // after `done`.
        cancelHiddenShim();

        if (currentToolCall && emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
        if (thinkingParser) {
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }

        if (textBlockIndex !== null) {
          const block = output.content[textBlockIndex] as TextContent | undefined;
          if (block) {
            stream.push({
              type: "text_end",
              contentIndex: textBlockIndex,
              content: block.text,
              partial: output,
            });
          }
        }

        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
        try {
          calculateCost(model, output.usage);
        } catch {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }

        const textBlock =
          textBlockIndex !== null
            ? (output.content[textBlockIndex] as TextContent | undefined)
            : undefined;
        const hasText = !!textBlock && textBlock.text.length > 0;
        if (!hasText && !sawAnyToolCalls) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            log.warn(`empty response — retrying (${retryCount}/${MAX_RETRIES})`);
            // Cancel the pending shim BEFORE the backoff delay so
            // it can't fire mid-wait. Retry re-arms a fresh timer.
            cancelHiddenShim();
            output.content = [];
            textBlockIndex = null;
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          log.warn(`empty response persisted after ${MAX_RETRIES} retries`);
          // No retries left — cancel any pending shim so it doesn't
          // fire after the empty-response path returns.
          cancelHiddenShim();
        }

        // Stop reason classification.
        // Prefer Kiro's authoritative metadataEvent — the real wire format
        // sends {"stopReason":"TOOL_USE"|"END_TURN"|"MAX_TOKENS"} as its own
        // event-stream frame (confirmed from a captured CLI response) — and
        // only fall back to heuristics when the server didn't send one.
        // Heuristic fallback: toolUse when tools were called; "length" when no
        // contextUsage event arrived AND no tool calls (treated as a truncation
        // signal); "stop" otherwise.
        const mappedServerStop = mapKiroStopReason(serverStopReason);
        if (mappedServerStop) {
          output.stopReason = mappedServerStop;
        } else if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }

        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        log.debug("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          usage: output.usage,
        });
        stream.end();
        return;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      log.debug("response.caught", { stopReason: output.stopReason, error: output.errorMessage });
      // Cancel the pending shim timer so no stray shim fires after
      // the error event. Nothing to close — the shim is self-
      // contained when it fires, and if the timer is still armed
      // here the shim simply never existed.
      if (hiddenShimTimer) {
        clearTimeout(hiddenShimTimer);
        hiddenShimTimer = null;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    try {
      stream.end();
    } catch {
      // ignore
    }
  });

  return stream;
}
