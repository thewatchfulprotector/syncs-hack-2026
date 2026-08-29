import { embedTexts } from "@/lib/openrouter";
import { queryChunks } from "@/lib/pineconeClient";

export const maxDuration = 30;

/**
 * Warm the OpenRouter connection and Pinecone host resolution so the first
 * real ask doesn't pay ~2s of cold-start. The page calls this on load.
 */
export async function POST(): Promise<Response> {
  const t0 = performance.now();
  try {
    const [vector] = await embedTexts(["warmup"]);
    await queryChunks(vector, "warmup", 1);
    return Response.json({ ok: true, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    return Response.json(
      { ok: false, message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
