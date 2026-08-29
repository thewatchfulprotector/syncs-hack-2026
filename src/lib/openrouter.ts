const BASE = "https://openrouter.ai/api/v1";

export const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const EMBEDDING_DIMENSION = 4096;

const EMBED_BATCH_SIZE = 32;

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("missing env var OPENROUTER_API_KEY");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** Embed texts with qwen3-embedding-8b, batching internally. Order is preserved. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) throw new Error(`OpenRouter embeddings: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    vectors.push(...sorted.map((d: { embedding: number[] }) => d.embedding));
  }
  return vectors;
}
