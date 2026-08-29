import type { ChatMessage } from "./prompt";

const BASE = "https://openrouter.ai/api/v1";

export const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const EMBEDDING_DIMENSION = 4096;
// Bake-off (2026-08-29): gemma-4-31b and gpt-oss-120b are latency-identical on
// Cerebras (~0.4-0.7s ttft); gemma tracked the persona cadence best. Gemini 3.7
// Flash burns 2.4-6.4s thinking before its first token — fallback only.
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "google/gemma-4-31b-it";
const FALLBACK_MODELS = ["openai/gpt-oss-120b", "google/gemini-3.7-flash"];
/** Only these model families accept the reasoning-effort parameter. */
const REASONING_MODELS = /gpt-oss|gemini/;

const EMBED_BATCH_SIZE = 32;

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("missing env var OPENROUTER_API_KEY");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

const CHAT_TIMEOUT_MS = 45_000;
const EMBED_TIMEOUT_MS = 10_000;

function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Stream chat completion tokens from gpt-oss-120b, preferring the fast
 * inference providers. Yields content deltas as they arrive. Aborting the
 * signal (client disconnect) cancels the upstream generation.
 */
export async function* streamChat(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    signal: withTimeout(CHAT_TIMEOUT_MS, signal),
    body: JSON.stringify({
      model: CHAT_MODEL,
      models: [CHAT_MODEL, ...FALLBACK_MODELS.filter((m) => m !== CHAT_MODEL)],
      provider: { order: ["cerebras", "groq"], allow_fallbacks: true },
      ...(REASONING_MODELS.test(CHAT_MODEL) ? { reasoning: { effort: "low" } } : {}),
      stream: true,
      messages,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter chat: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue; // skip SSE comments/keepalives
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        const parsed = JSON.parse(payload);
        // a provider can die mid-generation; surface it instead of ending
        // the stream as if the half-answer were complete
        if (parsed.error) throw new Error(`OpenRouter chat: ${parsed.error.message ?? "provider error"}`);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function embedBatch(
  batch: string[],
  providerOrder: string[],
  timeoutMs: number,
): Promise<number[][]> {
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      provider: { order: providerOrder, allow_fallbacks: true },
      input: batch,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter embeddings: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const sorted = [...body.data].sort((a, b) => a.index - b.index);
  return sorted.map((d: { embedding: number[] }) => d.embedding);
}

/** Embed texts with qwen3-embedding-8b, batching internally. Order is preserved. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  // Single-text embeds sit on the ask hot path, and each provider's latency has
  // a bad congestion tail (0.5s typical, 3-16s spikes). Race the two providers
  // that serve this model — uncorrelated backends — and take the winner.
  if (texts.length === 1) {
    return Promise.any([
      embedBatch(texts, ["deepinfra"], EMBED_TIMEOUT_MS),
      embedBatch(texts, ["nebius"], EMBED_TIMEOUT_MS),
    ]).catch((err: AggregateError) => {
      throw err.errors[0];
    });
  }
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    // ingest batches are big and latency-insensitive — allow a slow provider
    vectors.push(...(await embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE), ["deepinfra"], 120_000)));
  }
  return vectors;
}
