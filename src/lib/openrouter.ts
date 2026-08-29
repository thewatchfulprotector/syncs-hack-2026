import type { ChatMessage } from "./prompt";

const BASE = "https://openrouter.ai/api/v1";

// Embedding bake-off (2026-08-29, Sydney, n=10+ each): qwen3-embedding-8b on
// DeepInfra/Nebius jitters badly (median ~740ms with 3.4s spikes on ~30% of
// calls; the cross-provider race floors at Nebius' ~760ms). OpenAI's
// text-embedding-3-small via OpenRouter is fast and steady (median 364ms, p90
// 565ms) and matched 8b retrieval quality on the corpus eval (keyword-in-top-3
// 9/10 vs 8/10, top-1 agreement 8/10). Index: alexandria-te3small. This
// account reaches the model through Azure only (OpenAI's own endpoint is
// excluded by the account data policy), so the pin below must stay "azure".
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSION = 1536;
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
      max_completion_tokens: 256,
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
  signal?: AbortSignal,
): Promise<number[][]> {
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: headers(),
    signal: withTimeout(timeoutMs, signal),
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      // Each hedge leg must represent exactly one independent provider. An
      // OpenRouter fallback inside a leg hides the winner and multiplies work.
      provider: { order: providerOrder, allow_fallbacks: false },
      input: batch,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter embeddings: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const sorted = [...body.data].sort((a, b) => a.index - b.index);
  return sorted.map((d: { embedding: number[] }) => d.embedding);
}

// Just past the measured p90, so the retry fires on tail spikes only.
const EMBED_HEDGE_DELAY_MS = 600;

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Delayed same-model retry for the latency-sensitive one-query path. OpenAI is
 * the only provider serving this model, but its rare tail spikes are
 * uncorrelated between requests, so a duplicate request breaks them.
 */
async function embedSingle(
  texts: string[],
  signal?: AbortSignal,
  onProviderSelected?: (provider: string) => void,
): Promise<number[][]> {
  if (signal?.aborted) throw abortError(signal);

  const primaryController = new AbortController();
  const hedgeController = new AbortController();
  const primarySignal = signal
    ? AbortSignal.any([signal, primaryController.signal])
    : primaryController.signal;
  const hedgeSignal = signal
    ? AbortSignal.any([signal, hedgeController.signal])
    : hedgeController.signal;

  const primary = embedBatch(texts, ["azure"], EMBED_TIMEOUT_MS, primarySignal).then(
    (vectors) => ({ vectors, provider: "azure" }),
  );
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let startHedge!: () => void;

  const hedge = new Promise<{ vectors: number[][]; provider: string }>((resolve, reject) => {
    let started = false;
    const rejectIfAborted = () => {
      if (started) return;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      reject(abortError(hedgeSignal));
    };

    startHedge = () => {
      if (started) return;
      started = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      hedgeSignal.removeEventListener("abort", rejectIfAborted);
      embedBatch(texts, ["azure"], EMBED_TIMEOUT_MS, hedgeSignal).then(
        (vectors) => resolve({ vectors, provider: "azure-retry" }),
        reject,
      );
    };

    hedgeSignal.addEventListener("abort", rejectIfAborted, { once: true });
    hedgeTimer = setTimeout(startHedge, EMBED_HEDGE_DELAY_MS);
  });

  // A failed primary should not also pay the hedge delay.
  primary.catch(() => startHedge());

  try {
    const winner = await Promise.any([primary, hedge]);
    onProviderSelected?.(winner.provider);
    return winner.vectors;
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (err instanceof AggregateError) throw err.errors[0];
    throw err;
  } finally {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    // This cancels the loser (or a hedge that never needed to start).
    primaryController.abort();
    hedgeController.abort();
  }
}

/** Embed texts with qwen3-embedding-8b, batching internally. Order is preserved. */
export async function embedTexts(
  texts: string[],
  signal?: AbortSignal,
  onProviderSelected?: (provider: string) => void,
): Promise<number[][]> {
  if (texts.length === 1) {
    return embedSingle(texts, signal, onProviderSelected);
  }
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    // Ingest batches are latency-insensitive, but still keep routing explicit.
    vectors.push(
      ...(await embedBatch(
        texts.slice(i, i + EMBED_BATCH_SIZE),
        ["azure"],
        120_000,
        signal,
      )),
    );
  }
  onProviderSelected?.("azure");
  return vectors;
}
