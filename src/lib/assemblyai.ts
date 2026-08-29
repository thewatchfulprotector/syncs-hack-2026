import { z } from "zod";
import type { AAIUtterance } from "./diarization";

const BASE = "https://api.assemblyai.com/v2";

export type Transcript = {
  id: string;
  status: string;
  text: string;
  audio_duration: number;
  utterances: AAIUtterance[];
};

// Loose objects: validate the fields we depend on without stripping the rest,
// so cached transcripts keep the full payload of the paid transcription call.
const wordSchema = z.looseObject({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  speaker: z.string().optional(),
});

const utteranceSchema = z.looseObject({
  speaker: z.string(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  words: z.array(wordSchema),
});

const transcriptSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  text: z.string(),
  audio_duration: z.number(),
  // AssemblyAI returns utterances: null when diarization fails, even on a
  // "completed" transcript — reject that instead of typing it away.
  utterances: z.array(utteranceSchema),
});

/** Validate a completed-transcript payload (live response or cache file). */
export function parseTranscript(data: unknown): Transcript {
  const result = transcriptSchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`unexpected AssemblyAI transcript shape: ${detail}`);
  }
  return result.data;
}

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
  // Construct a view over the Buffer instead of copying hundreds of megabytes
  // for long podcast uploads.
  const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: { Authorization: headers().Authorization },
    // Node's fetch accepts ArrayBuffer views; the DOM lib's BodyInit typing is
    // narrower for Buffer-backed ArrayBufferLike values.
    body: body as unknown as BodyInit,
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
    if (body.status === "completed") return parseTranscript(body);
    if (body.status === "error") throw new Error(`AssemblyAI transcription: ${body.error}`);
  }
  throw new Error(`AssemblyAI transcription ${id} timed out`);
}
