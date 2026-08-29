import type { ChatMessage } from "./prompt";

const BASE = "https://openrouter.ai/api/v1";

export const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const EMBEDDING_DIMENSION = 4096;
export const CHAT_MODEL = "openai/gpt-oss-120b";

const EMBED_BATCH_SIZE = 32;

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("missing env var OPENROUTER_API_KEY");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/**
 * Stream chat completion tokens from gpt-oss-120b, preferring the fast
 * inference providers. Yields content deltas as they arrive.
 */
export async function* streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      provider: { order: ["cerebras", "groq"], allow_fallbacks: true },
      reasoning: { effort: "low" },
      stream: true,
      messages,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter chat: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
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
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

/** Embed texts with qwen3-embedding-8b, batching internally. Order is preserved. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        // DeepInfra serves this model in ~0.5-1s; the alternative (Nebius) swings 1.5-6s.
        // Fallbacks stay on so an outage degrades latency instead of breaking asks.
        provider: { order: ["deepinfra"], allow_fallbacks: true },
        input: batch,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter embeddings: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    vectors.push(...sorted.map((d: { embedding: number[] }) => d.embedding));
  }
  return vectors;
}
