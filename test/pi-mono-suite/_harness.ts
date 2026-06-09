// Shared harness for the pi-mono-equivalent suites.
//
// These 11 suites replicate the scenarios in `pi-mono/packages/ai/test/` —
// `stream`, `tokens`, `abort`, `empty`, `context-overflow`, `image-limits`,
// `unicode-surrogate`, `tool-call-without-result`, `image-tool-result`,
// `total-tokens`, `cross-provider-handoff` — adapted to pi-kiro's provider.
//
// Live mode: set `KIRO_LIVE_TEST=1` and provide `KIRO_ACCESS_TOKEN` to run
// against the real Kiro API. Without those the suites skip with a message.

import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { kiroModels } from "../../src/models";
import { streamKiro } from "../../src/stream";

export const LIVE = process.env.KIRO_LIVE_TEST === "1";
export const KIRO_TOKEN = process.env.KIRO_ACCESS_TOKEN ?? "";

/** Default model for suite tests: Claude Haiku 4.5 (fast, multimodal). */
export function suiteModel(overrides?: Partial<Model<Api>>): Model<Api> {
  const m = kiroModels.find((x) => x.id === "claude-haiku-4-5");
  if (!m) throw new Error("suiteModel: claude-haiku-4-5 not in catalog");
  return { ...m, ...overrides };
}

export function suiteOptions(overrides?: SimpleStreamOptions): SimpleStreamOptions {
  return { apiKey: KIRO_TOKEN, ...overrides };
}

export async function complete(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const s = streamKiro(model, context, options);
  return s.result();
}

export { streamKiro };
