// Kiro CLI identity defaults — data that may change with client updates.
// Keep this file in sync with real Kiro CLI behavior (Charles proxy captures).

/**
 * Synthetic history seed injected at the start of every conversation.
 * The real Kiro CLI sends this exact pair before real history.
 * Use `{{modelId}}` placeholder — replaced at runtime with the dot-format model id.
 */
export const SYSTEM_SEED_INSTRUCTION =
  "Follow this instruction: # Kiro CLI Default Agent\n\n" +
  "You are the default Kiro CLI agent, bringing the power of AI-assisted development " +
  "directly to the user's terminal. You help with coding tasks, system operations, " +
  "AWS management, and development workflows.\n\n" +
  "The current model is {{modelId}}.\n";

export const SYSTEM_SEED_ACK =
  "I will fully incorporate this information when generating my responses, " +
  "and explicitly acknowledge relevant parts of the summary when answering questions.";

/**
 * Every tool schema in the real Kiro CLI includes this extra property.
 * Injected by `convertToolsToKiro()` into each tool's input schema.
 */
export const TOOL_PURPOSE_FIELD = {
  type: "string",
  description: "A brief explanation why you are making this tool use.",
} as const;

/** Map `process.platform` to Kiro's `operatingSystem` values. */
export function resolveOS(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return process.platform; // linux, etc.
  }
}

/**
 * Context usage percentage at which pi-kiro forces Pi's overflow detection.
 * When Kiro reports >= this value, `usage.input` is inflated above
 * `contextWindow` so Pi's `isContextOverflow()` returns true and triggers
 * compaction before hitting a 413.
 */
export const COMPACTION_THRESHOLD_PCT = 95;
