import { createStreamingToken } from "@/lib/assemblyai";

export const maxDuration = 15;

/** Short-lived AssemblyAI streaming token so the browser can open the STT websocket. */
export async function POST(): Promise<Response> {
  try {
    return Response.json({ token: await createStreamingToken(60) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
