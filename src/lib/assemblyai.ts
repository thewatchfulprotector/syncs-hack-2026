import type { AAIUtterance } from "./diarization";

const BASE = "https://api.assemblyai.com/v2";

export type Transcript = {
  id: string;
  status: string;
  text: string;
  audio_duration: number;
  utterances: AAIUtterance[];
};

function headers(): Record<string, string> {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error("missing env var ASSEMBLYAI_API_KEY");
  return { Authorization: key, "Content-Type": "application/json" };
}

/**
 * Mint a short-lived token for the browser to open a realtime streaming STT
 * websocket without ever seeing the API key.
 */
export async function createStreamingToken(expiresInSeconds = 60): Promise<string> {
  const res = await fetch(
    `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${expiresInSeconds}`,
    {
      headers: { Authorization: headers().Authorization },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!res.ok) throw new Error(`AssemblyAI token: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

/** Upload a local media file; returns a URL usable as transcription input. */
export async function uploadMedia(data: Buffer): Promise<string> {
  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: { Authorization: headers().Authorization },
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`AssemblyAI upload: ${res.status} ${await res.text()}`);
  const { upload_url } = await res.json();
  return upload_url;
}

/** Async transcription with speaker diarization + word timestamps; polls to completion. */
export async function transcribeAudio(
  audioUrl: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<Transcript> {
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;

  const create = await fetch(`${BASE}/transcript`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true }),
  });
  if (!create.ok) throw new Error(`AssemblyAI create: ${create.status} ${await create.text()}`);
  const { id } = await create.json();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const res = await fetch(`${BASE}/transcript/${id}`, { headers: headers() });
    const body = await res.json();
    if (body.status === "completed") return body as Transcript;
    if (body.status === "error") throw new Error(`AssemblyAI transcription: ${body.error}`);
  }
  throw new Error(`AssemblyAI transcription ${id} timed out`);
}
