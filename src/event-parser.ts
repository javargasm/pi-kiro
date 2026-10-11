// Kiro JSON event parser.
//
// Kiro's streaming response interleaves JSON event objects inside an AWS
// Event Stream binary envelope. We scan for known JSON prefix patterns
// (avoiding framing noise), extract brace-balanced JSON, and dispatch to
// typed event objects.

import { log } from "./debug";

export type KiroStreamEvent =
  | { type: "content"; data: string }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "reasoning"; data: { text: string; signature?: string } }
  | { type: "usage"; data: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; data: { error: string; message?: string } }
  | { type: "metadata"; data: { stopReason?: string } };

/** Find the matching `}` for the `{` at `start`. Returns -1 if incomplete. */
export function findJsonEnd(text: string, start: number): number {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

export function parseKiroEvent(parsed: Record<string, unknown>): KiroStreamEvent | null {
  if (parsed.content !== undefined) {
    return { type: "content", data: parsed.content as string };
  }

  if (parsed.reasoningText !== undefined || parsed.signature !== undefined || (parsed.text !== undefined && !parsed.content && !parsed.name && !parsed.message)) {
    let text = "";
    let signature: string | undefined;

    if (parsed.reasoningText) {
      const rt = parsed.reasoningText as Record<string, unknown>;
      text = ((rt.text ?? rt.Text) || "") as string;
      signature = (rt.signature ?? rt.Signature) as string | undefined;
    } else {
      text = (parsed.text as string) || "";
      signature = parsed.signature as string | undefined;
    }

    return {
      type: "reasoning",
      data: { text, signature },
    };
  }

  if (parsed.name && parsed.toolUseId) {
    const rawInput = parsed.input;
    const input =
      typeof rawInput === "string"
        ? rawInput
        : rawInput && typeof rawInput === "object" && Object.keys(rawInput as Record<string, unknown>).length > 0
          ? JSON.stringify(rawInput)
          : "";
    return {
      type: "toolUse",
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input,
        stop: parsed.stop as boolean | undefined,
      },
    };
  }

  if (parsed.input !== undefined && !parsed.name) {
    return {
      type: "toolUseInput",
      data: {
        input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input),
      },
    };
  }

  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
    return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  }

  if (parsed.contextUsagePercentage !== undefined) {
    return {
      type: "contextUsage",
      data: { contextUsagePercentage: parsed.contextUsagePercentage as number },
    };
  }

  if (parsed.error !== undefined || parsed.Error !== undefined) {
    const err = (parsed.error || parsed.Error || "unknown") as string | Record<string, unknown>;
    const message = (parsed.message || parsed.Message || parsed.reason) as string | undefined;
    return {
      type: "error",
      data: {
        error: typeof err === "string" ? err : JSON.stringify(err),
        message,
      },
    };
  }

  if (parsed.usage !== undefined && typeof parsed.usage === "object" && parsed.usage !== null) {
    // A real usageEvent carries an OBJECT ({inputTokens, outputTokens}). A
    // meteringEvent ({"unit":"credit","usage":<number>}) also has a `usage`
    // key, but its value is a NUMBER (credit cost). Without the object guard,
    // a metering frame emits a bogus usage event with undefined tokens, which
    // clobbers a real usageEvent that arrived earlier in the same stream.
    const u = parsed.usage as Record<string, unknown>;
    return {
      type: "usage",
      data: {
        inputTokens: u.inputTokens as number | undefined,
        outputTokens: u.outputTokens as number | undefined,
      },
    };
  }

  // metadataEvent carries the authoritative stop reason from Kiro
  // (real frame: {"stopReason":"TOOL_USE"|"END_TURN"|"MAX_TOKENS"}). Surface it
  // so the stream layer can prefer it over heuristic classification.
  if (typeof parsed.stopReason === "string") {
    return { type: "metadata", data: { stopReason: parsed.stopReason } };
  }

  return null;
}

/**
 * Known JSON prefixes that start a Kiro event. Explicit matching avoids the
 * `{"` sequences inside the AWS Event Stream binary envelope.
 */
const EVENT_PATTERNS = [
  '{"content":',
  '{"reasoningText":',
  '{"signature":',
  '{"text":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"stopReason":',
  '{"followupPrompt":', // consumed and ignored, so its nested content isn't scanned
  '{"usage":',
  '{"toolUseId":',
  '{"unit":',
  '{"error":',
  '{"Error":',
  '{"message":',
];

function findNextEventStart(buffer: string, from: number): number {
  let earliest = -1;
  for (const pattern of EVENT_PATTERNS) {
    const idx = buffer.indexOf(pattern, from);
    if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

/**
 * AWS Event Stream (application/vnd.amazon.eventstream) frames an exception as
 * a message whose type lives in the `:exception-type` header (with
 * `:message-type: exception`); the JSON payload is typically just
 * `{"message":"..."}` — the type is NOT in the payload. The heuristic JSON
 * scanner below can't see header bytes, so detect the exception framing
 * directly. Header name/value strings survive UTF-8 decoding even though the
 * surrounding 1-byte value-type + 2-byte length bytes are control characters,
 * so allow up to a few arbitrary bytes between the header name and its value.
 */
const EXCEPTION_TYPE_RE = /:exception-type[\s\S]{0,4}?([A-Za-z][A-Za-z0-9]*(?:Exception|Error|Fault))/;
const MESSAGE_TYPE_EXCEPTION_RE = /:message-type[\s\S]{0,4}?exception\b/;

export function detectEventStreamException(
  buffer: string,
): { type: string; message?: string } | null {
  const typeMatch = buffer.match(EXCEPTION_TYPE_RE);
  if (!typeMatch && !MESSAGE_TYPE_EXCEPTION_RE.test(buffer)) return null;
  const type = typeMatch?.[1] ?? "ServiceException";

  // The human-readable message is in the last {"message":...} payload, if the
  // frame's payload arrived complete. The type alone is enough to surface it.
  let message: string | undefined;
  const msgIdx = buffer.lastIndexOf('{"message":');
  if (msgIdx >= 0) {
    const end = findJsonEnd(buffer, msgIdx);
    if (end >= 0) {
      try {
        const parsed = JSON.parse(buffer.substring(msgIdx, end + 1)) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // payload not yet complete — type alone still surfaces the error
      }
    }
  }
  return { type, message };
}

export function parseKiroEvents(
  buffer: string,
): { events: KiroStreamEvent[]; remaining: string } {
  const events: KiroStreamEvent[] = [];
  let pos = 0;
  let remaining = "";

  while (pos < buffer.length) {
    const jsonStart = findNextEventStart(buffer, pos);
    if (jsonStart < 0) {
      // No known event prefix in the remainder. If there are brace-opens
      // sitting in the gap, surface them — that's where an unrecognized
      // top-level key would live.
      if (log.isDebug()) {
        const gap = buffer.substring(pos);
        const braceIdx = gap.indexOf('{"');
        if (braceIdx >= 0) {
          log.debug("event.unmatchedBrace", {
            from: pos + braceIdx,
            preview: gap.substring(braceIdx, Math.min(braceIdx + 200, gap.length)),
          });
        }
      }
      break;
    }

    if (log.isDebug() && jsonStart > pos) {
      // Bytes skipped between pos and the next known event — usually binary
      // framing, but worth peeking at once so we can tell.
      const skipped = buffer.substring(pos, jsonStart);
      const braceIdx = skipped.indexOf('{"');
      if (braceIdx >= 0) {
        log.debug("event.skippedBrace", {
          from: pos + braceIdx,
          preview: skipped.substring(braceIdx, Math.min(braceIdx + 200, skipped.length)),
        });
      }
    }

    const jsonEnd = findJsonEnd(buffer, jsonStart);
    if (jsonEnd < 0) {
      // Incomplete JSON at end of buffer — preserve for next call.
      remaining = buffer.substring(jsonStart);
      break;
    }

    try {
      const parsed = JSON.parse(buffer.substring(jsonStart, jsonEnd + 1)) as Record<
        string,
        unknown
      >;
      const event = parseKiroEvent(parsed);
      if (event) {
        events.push(event);
      } else if (log.isDebug()) {
        // Frame parsed cleanly but didn't match any known event shape.
        // This is the primary signal for a new upstream event type
        // (e.g. a native `reasoning` / `thinking` block from Kiro 4.7).
        log.debug("event.unknown", { keys: Object.keys(parsed), raw: parsed });
      }
    } catch (err) {
      // Brace-balanced but not valid JSON — skip.
      if (log.isDebug()) {
        log.debug("event.parseFail", {
          err: err instanceof Error ? err.message : String(err),
          snippet: buffer.substring(jsonStart, Math.min(jsonEnd + 1, jsonStart + 200)),
        });
      }
    }
    pos = jsonEnd + 1;
  }

  // AWS Event Stream exception frame: the type is in the `:exception-type`
  // header (invisible to the JSON scanner above, whose payload is just
  // {"message":...}). Surface it as an error event so the stream layer fails /
  // retries instead of treating the truncated stream as a clean finish. Guard
  // against double-emitting when the payload already carried an `error` key.
  const exception = detectEventStreamException(buffer);
  if (exception && !events.some((e) => e.type === "error")) {
    events.push({ type: "error", data: { error: exception.type, message: exception.message } });
    remaining = ""; // exception is terminal; nothing useful left to buffer
  }

  return { events, remaining };
}
