// pi Message[] → Kiro history transformation.
//
// Kiro uses an alternating userInputMessage/assistantResponseMessage shape.
// We merge consecutive user messages (and tool-result entries) into the
// preceding user message to satisfy alternation without synthetic padding —
// the padding used to cause echo-loop bugs downstream.

import type {
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";


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
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
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
    valid.push({
      format: img.mimeType.split("/")[1] || "png",
      source: { bytes: img.data },
    });
  }

  return { images: valid, omitted };
}

// ---- History builder ---------------------------------------------------

/**
 * Split messages into history + current turn. The current turn is the trailing
 * user message (+ any following tool results) or the trailing assistant
 * message when it carries tool calls. Everything before goes into history.
 *
 * System prompt is prepended to the first user message in history, not sent
 * as a separate field (Kiro doesn't have one).
 */
export function buildHistory(
  messages: Message[],
  _modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;

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
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
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
      let armContent = "";
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            armContent += (block as TextContent).text;
          } else if (block.type === "thinking") {
            armContent = `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n${armContent}`;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: toKiroToolUseId(tc.id),
              input: parseToolArgs(tc.arguments),
            });
          }
        }
      }
      if (!armContent && armToolUses.length === 0) continue;
      history.push({
        assistantResponseMessage: {
          content: armContent,
          ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
        },
      });
      continue;
    }

    // toolResult — batch consecutive results
    const trMsg = msg as ToolResultMessage;
    const toolResults: KiroToolResult[] = [
      {
        content: [{ text: truncate(getContentText(msg), TOOL_RESULT_LIMIT) }],
        status: trMsg.isError ? "error" : "success",
        toolUseId: toKiroToolUseId(trMsg.toolCallId),
      },
    ];
    const trImages: ImageContent[] = [];
    if (Array.isArray(trMsg.content)) {
      for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
    }

    let j = i + 1;
    while (j < historyMessages.length && historyMessages[j]?.role === "toolResult") {
      const next = historyMessages[j] as ToolResultMessage;
      toolResults.push({
        content: [{ text: truncate(getContentText(next), TOOL_RESULT_LIMIT) }],
        status: next.isError ? "error" : "success",
        toolUseId: toKiroToolUseId(next.toolCallId),
      });
      if (Array.isArray(next.content)) {
        for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
      }
      j++;
    }
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

  return { history: collapseAgenticLoops(history), systemPrepended, currentMsgStartIdx };
}

// ---- Agentic loop collapse --------------------------------------------

/**
 * Collapse consecutive tool-use loops in history. When the agent calls
 * tools N times in sequence (ASST(toolUses) → USER(toolResults) pairs),
 * keep text only on the first assistant message and replace subsequent
 * ones with a short placeholder. This prevents the model from re-deriving
 * its preamble on every iteration, saving context tokens.
 */
export function collapseAgenticLoops(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  if (history.length < 4) return history;

  const result: KiroHistoryEntry[] = [];
  let i = 0;

  while (i < history.length) {
    const entry = history[i];

    // Detect start of agentic sequence:
    // ASST with toolUses followed by USER with toolResults
    if (
      entry?.assistantResponseMessage?.toolUses &&
      i + 1 < history.length &&
      history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      // Walk forward to find the end of the contiguous sequence
      let j = i;
      while (j < history.length) {
        const asst = history[j];
        if (!asst?.assistantResponseMessage?.toolUses) break;
        const nextUser = j + 1 < history.length ? history[j + 1] : null;
        if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults) break;
        j += 2;
      }

      const pairCount = (j - i) / 2;

      if (pairCount > 1) {
        // Multi-iteration loop: keep full text on first pair only
        for (let k = i; k < j; k += 2) {
          const asst = history[k]!;
          const user = history[k + 1]!;

          if (k === i) {
            result.push(asst);
          } else {
            result.push({
              assistantResponseMessage: {
                content: "[tool calling continues]",
                toolUses: asst.assistantResponseMessage!.toolUses,
              },
            });
          }
          result.push(user);
        }
      } else {
        // Single pair — keep as-is
        result.push(history[i]!, history[i + 1]!);
      }
      i = j;
    } else {
      result.push(entry!);
      i++;
    }
  }

  return result;
}
