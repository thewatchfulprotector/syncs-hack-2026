import { createStreamingToken } from "@/lib/assemblyai";

export const maxDuration = 15;
const TOKEN_TTL_SECONDS = 300;

/** Short-lived AssemblyAI streaming token so the browser can open the STT websocket. */
export async function POST(req: Request): Promise<Response> {
  const requestedCorrelationId = req.headers.get("x-correlation-id")?.trim();
  const correlationId =
    requestedCorrelationId && /^[A-Za-z0-9._:-]{8,128}$/.test(requestedCorrelationId)
      ? requestedCorrelationId
      : crypto.randomUUID();
  const headers = {
    "Cache-Control": "no-store",
    "X-Correlation-Id": correlationId,
  };
  try {
    const issuedAt = Date.now();
    return Response.json(
      {
        token: await createStreamingToken(TOKEN_TTL_SECONDS),
        issuedAt,
        expiresAt: issuedAt + TOKEN_TTL_SECONDS * 1000,
        correlationId,
      },
      { headers },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), correlationId },
      { status: 500, headers },
    );
  }
}
