// pi Message[] → Kiro history transformation.
//
// Kiro uses an alternating userInputMessage/assistantResponseMessage shape.
// We merge consecutive user messages (and tool-result entries) into the
// preceding user message to satisfy alternation without synthetic padding —
// the padding used to cause echo-loop bugs downstream.

import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

// pi-ai >= 0.87 system message. Declared locally so we still build against
// older pi-ai whose Message union has no "system" role.
interface SystemMessageLike {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: Array<{ name: string }>;
}

function textOf(content: string | TextContent[]): string {
  return typeof content === "string" ? content : content.map((c) => c.text).join("");
}

/** pi >= 0.87 moves `systemPrompt`/`tools` into `role: "system"` messages
 *  (leading prompt + mid-conversation deltas). Kiro has no system role, so
 *  replay them the way pi-ai's getCurrentSystemPrompt/getCurrentTools do and
 *  return a context with only user/assistant/toolResult messages. */
export function resolveContext(context: Context): Context {
  const all = context.messages as Array<Message | SystemMessageLike>;
  if (!all.some((m) => m.role === "system")) return context;

  const content: string[] = context.systemPrompt ? [context.systemPrompt] : [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>((context.tools ?? []).map((t) => [t.name, t]));
  const messages: Message[] = [];
  for (const m of all) {
    if (m.role !== "system") {
      messages.push(m);
      continue;
    }
    const text = textOf(m.content);
    if (text) content.push(text);
    for (const [name, value] of Object.entries(m.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
  }
  const systemPrompt = [content.join("\n\n"), ...sections.values()].filter(Boolean).join("\n\n");
  return {
    ...context,
    systemPrompt: systemPrompt || undefined,
    tools: tools.size > 0 ? [...tools.values()] : undefined,
    messages,
  };
}


/** Drop assistant messages that ended in error/aborted — partial turns
 *  shouldn't be replayed. */
export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter(
    (msg) =>
      msg.role !== "assistant" ||
      (msg.stopReason !== "error" && msg.stopReason !== "aborted"),
  );
}

// ---- Kiro wire format --------------------------------------------------

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}

export interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface KiroEnvState {
  operatingSystem: string;
  currentWorkingDirectory: string;
}

export interface KiroUserInputMessage {
  content: string;
  modelId?: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: {
    envState?: KiroEnvState;
    toolResults?: KiroToolResult[];
    tools?: KiroToolSpec[];
  };
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
  reasoningContent?: {
    reasoningText: {
      text: string;
      signature: string;
    };
  };
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

/**
 * Minimal placeholder tool injected when the conversation history contains
 * toolUse/toolResult blocks but the current request supplies no tools.
 * Bedrock returns TOOL_CONFIG_MISSING ("The toolConfig field must be defined
 * when using toolUse and toolResult content blocks") if tool blocks appear
 * without a toolConfig. pi sends auxiliary turns (title generation,
 * summarization, compaction) WITHOUT tools, yet the replayed history still
 * carries tool blocks from earlier turns — so the request 400s and retries
 * identically in a loop. This placeholder makes toolConfig non-empty without
 * inviting the model to call anything on those auxiliary turns.
 */
export const KIRO_PLACEHOLDER_TOOL: KiroToolSpec = {
  toolSpecification: {
    name: "noop",
    description:
      "Placeholder tool. Do not call it. Present only to satisfy the toolConfig requirement when replayed history contains tool blocks.",
    inputSchema: { json: { type: "object", properties: {} } },
  },
};

/**
 * True when any history entry carries assistant toolUses or user toolResults.
 * Used to decide whether a tools-less request still needs a toolConfig to
 * avoid Bedrock's TOOL_CONFIG_MISSING validation error.
 */
export function historyHasToolBlocks(history: KiroHistoryEntry[]): boolean {
  for (const entry of history) {
    if (entry.assistantResponseMessage?.toolUses?.length) return true;
    if (entry.userInputMessage?.userInputMessageContext?.toolResults?.length) return true;
  }
  return false;
}

// ---- Utilities ---------------------------------------------------------

export const TOOL_RESULT_LIMIT = 250_000;

/** Maximum images per message accepted by the Kiro API. */
export const MAX_KIRO_IMAGES = 4;

/** Maximum decoded size per image (bytes) accepted by the Kiro API. */
export const MAX_KIRO_IMAGE_BYTES = 3_750_000;

/** Middle-ellipsis truncation: preserve start and end. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") {
    return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((c) => {
      if (c.type === "text") return (c as TextContent).text;
      if (c.type === "thinking") return (c as ThinkingContent).thinking;
      return "";
    })
    .join("");
}

/**
 * Parse tool-call arguments defensively. Historical messages (including
 * those from other providers via cross-provider handoff) may carry args
 * that aren't valid JSON. Fall back to {} rather than crashing the stream.
 */
export function parseToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  if (typeof input !== "string") return {};
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const KIRO_TOOL_USE_ID_RE = /^tooluse_[A-Za-z0-9]+$/;

/**
 * Kiro accepts its own compact `tooluse_*` IDs in replayed history. Other
 * providers / harness layers can produce IDs such as `call_...|fc_...`, which
 * Kiro rejects as `Invalid tool use format`. Canonicalize only the wire-format
 * ID while preserving deterministic toolUse/toolResult matching.
 */
export function toKiroToolUseId(id: string): string {
  if (KIRO_TOOL_USE_ID_RE.test(id)) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 22);
  return `tooluse_${digest}`;
}

/** Image formats Bedrock/Kiro accepts. */
const KIRO_IMAGE_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);

/**
 * Map a MIME type to a Kiro-accepted image `format`, or null if unsupported.
 * Normalizes `image/jpg` → `jpeg` and strips structured-syntax suffixes /
 * vendor prefixes so `image/svg+xml` is correctly rejected (null) instead of
 * yielding a bogus `svg+xml` format that the API would refuse.
 */
export function normalizeImageFormat(mimeType: string): string | null {
  const sub = (mimeType.split("/")[1] || "").toLowerCase().split(";")[0]!.trim();
  const base = sub.replace(/\+.*$/, "").replace(/^vnd\./, "");
  const canonical = base === "jpg" ? "jpeg" : base;
  return KIRO_IMAGE_FORMATS.has(canonical) ? canonical : null;
}

/**
 * Convert images to Kiro wire format, enforcing API limits:
 * - Max {@link MAX_KIRO_IMAGES} images per call
 * - Max {@link MAX_KIRO_IMAGE_BYTES} decoded bytes per image
 *
 * Oversized/excess images are silently dropped and counted in `omitted`.
 */
export function convertImagesToKiro(
  images: Array<{ mimeType: string; data: string }>,
): { images: KiroImage[]; omitted: number } {
  let omitted = 0;
  const valid: KiroImage[] = [];

  for (const img of images) {
    // base64 encodes 3 bytes per 4 chars
    const estimatedBytes = Math.ceil(img.data.length * 3 / 4);
    if (estimatedBytes > MAX_KIRO_IMAGE_BYTES) {
      omitted++;
      continue;
    }
    if (valid.length >= MAX_KIRO_IMAGES) {
      omitted++;
      continue;
    }
    const format = normalizeImageFormat(img.mimeType);
    if (!format) {
      // Unsupported subtype (e.g. image/svg+xml): can't relabel raw bytes as a
      // raster format, so omit it rather than send an invalid `format`.
      omitted++;
      continue;
    }
    valid.push({
      format,
      source: { bytes: img.data },
    });
  }

  return { images: valid, omitted };
}

/**
 * pi assistant message → Kiro assistantResponseMessage, or null when it carries
 * nothing. Thinking is replayed as `reasoningContent`, never inline
 * `<thinking>` tags, and only with a signature — Bedrock rejects a missing or
 * corrupt one with THINKING_SIGNATURE_INVALID.
 */
export function toKiroAssistant(msg: AssistantMessage): KiroAssistantResponseMessage | null {
  let content = "";
  let reasoningText = "";
  let signature = "";
  const toolUses: KiroToolUse[] = [];
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "thinking") {
      reasoningText += block.thinking;
      if (block.thinkingSignature) signature = block.thinkingSignature;
    } else if (block.type === "toolCall") {
      toolUses.push({
        name: block.name,
        toolUseId: toKiroToolUseId(block.id),
        input: parseToolArgs(block.arguments),
      });
    }
  }
  if (!content && toolUses.length === 0 && !reasoningText) return null;
  return {
    content,
    ...(toolUses.length > 0 ? { toolUses } : {}),
    ...(reasoningText && signature
      ? { reasoningContent: { reasoningText: { text: reasoningText, signature } } }
      : {}),
  };
}

/** pi toolResult messages (others are skipped) → Kiro toolResults + their images. */
export function toKiroToolResults(msgs: Message[]): { toolResults: KiroToolResult[]; images: ImageContent[] } {
  const toolResults: KiroToolResult[] = [];
  const images: ImageContent[] = [];
  for (const m of msgs) {
    if (m.role !== "toolResult") continue;
    toolResults.push({
      content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
      status: m.isError ? "error" : "success",
      toolUseId: toKiroToolUseId(m.toolCallId),
    });
    for (const c of m.content) if (c.type === "image") images.push(c);
  }
  return { toolResults, images };
}

// ---- History builder ---------------------------------------------------

/**
 * Split messages into history + current turn. The current turn is the trailing
 * user message (+ any following tool results) or the trailing assistant
 * message when it carries tool calls. Everything before goes into history.
 */
export function buildHistory(
  messages: Message[],
): { history: KiroHistoryEntry[]; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];

  // Walk backwards to find where the "current turn" begins.
  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx]?.role === "toolResult") {
    currentMsgStartIdx--;
  }
  const anchor = messages[currentMsgStartIdx];
  if (anchor?.role === "assistant") {
    const hasToolCall =
      Array.isArray(anchor.content) && anchor.content.some((b) => b.type === "toolCall");
    if (!hasToolCall) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (!msg) continue;

    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content,
        origin: "KIRO_CLI",
        ...(images.length > 0 ? { images: convertImagesToKiro(images).images } : {}),
      };

      const prev = history[history.length - 1];
      if (prev?.userInputMessage) {
        // Merge into previous user message — Kiro alternates user/assistant.
        prev.userInputMessage.content += `\n\n${uim.content}`;
        if (uim.images) {
          prev.userInputMessage.images = [...(prev.userInputMessage.images ?? []), ...uim.images];
        }
      } else {
        history.push({ userInputMessage: uim });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const arm = toKiroAssistant(msg);
      if (arm) history.push({ assistantResponseMessage: arm });
      continue;
    }

    // toolResult — batch consecutive results
    let j = i + 1;
    while (j < historyMessages.length && historyMessages[j]?.role === "toolResult") j++;
    const { toolResults, images: trImages } = toKiroToolResults(historyMessages.slice(i, j));
    i = j - 1;

    const prev = history[history.length - 1];
    if (prev?.userInputMessage) {
      // Merge tool results into previous user message to preserve alternation.
      prev.userInputMessage.content += "\n\nTool results provided.";
      if (trImages.length > 0) {
        prev.userInputMessage.images = [
          ...(prev.userInputMessage.images ?? []),
          ...convertImagesToKiro(trImages).images,
        ];
      }
      if (!prev.userInputMessage.userInputMessageContext) {
        prev.userInputMessage.userInputMessageContext = {};
      }
      prev.userInputMessage.userInputMessageContext.toolResults = [
        ...(prev.userInputMessage.userInputMessageContext.toolResults ?? []),
        ...toolResults,
      ];
    } else {
      history.push({
        userInputMessage: {
          content: "Tool results provided.",
          origin: "KIRO_CLI",
          ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages).images } : {}),
          userInputMessageContext: { toolResults },
        },
      });
    }
  }

  return { history: sanitizeHistory(history), currentMsgStartIdx };
}

// ---- History sanitization ---------------------------------------------

/**
 * Sanitize the Kiro history to prevent Bedrock validation errors:
 *
 * 1. **TOOL_DUPLICATE**: Deduplicate toolUseIds within each assistant
 *    message — keep the first occurrence, drop subsequent ones.
 *
 * 2. **TOOL_USE_RESULT_MISMATCH**: Every ASST with toolUses must be
 *    followed by a USER with toolResults whose IDs match. Remove
 *    orphan toolUses that have no matching toolResult in the next
 *    message, and remove orphan toolResults whose toolUse doesn't
 *    exist in the preceding assistant.
 *
 * This runs as a defensive last pass — upstream logic (buildHistory,
 * stream.ts current-turn assembly) should produce correct output, but
 * edge cases in retry / cross-provider handoff can violate the
 * invariants Bedrock enforces.
 */
export function sanitizeHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const arm = entry?.assistantResponseMessage;
    if (!arm?.toolUses || arm.toolUses.length === 0) continue;

    // 1. Deduplicate toolUseIds within the same assistant message.
    const seen = new Set<string>();
    arm.toolUses = arm.toolUses.filter((tu) => {
      if (seen.has(tu.toolUseId)) return false;
      seen.add(tu.toolUseId);
      return true;
    });

    // 2. Ensure the next entry is a USER with matching toolResults.
    const next = i + 1 < history.length ? history[i + 1] : undefined;
    const toolResults = next?.userInputMessage?.userInputMessageContext?.toolResults;
    if (!toolResults) {
      // No matching toolResults at all — strip toolUses to avoid
      // TOOL_USE_RESULT_MISMATCH.
      delete arm.toolUses;
      continue;
    }

    const resultIdSet = new Set(toolResults.map((tr) => tr.toolUseId));
    const useIdSet = new Set(arm.toolUses.map((tu) => tu.toolUseId));

    // Remove toolUses without a matching toolResult.
    arm.toolUses = arm.toolUses.filter((tu) => resultIdSet.has(tu.toolUseId));
    if (arm.toolUses.length === 0) delete arm.toolUses;

    // Remove toolResults without a matching toolUse.
    const ctx = next!.userInputMessage!.userInputMessageContext!;
    ctx.toolResults = toolResults.filter((tr) => useIdSet.has(tr.toolUseId));
    if (ctx.toolResults.length === 0) delete ctx.toolResults;
  }

  return history;
}
