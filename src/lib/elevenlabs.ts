const BASE = "https://api.elevenlabs.io/v1";

export const TTS_MODEL = "eleven_flash_v2_5";
/** Stock voice used until a persona has its own clone. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("missing env var ELEVENLABS_API_KEY");
  return key;
}

export type TtsResult = {
  stream: ReadableStream<Uint8Array>;
  requestId?: string;
  servingRegion?: string;
  model: typeof TTS_MODEL;
  format: "pcm_s16le";
  sampleRate: 24_000;
  channels: 1;
};

/**
 * Instant Voice Clone from sample audio (ideally 1-3 minutes of clean solo
 * speech — exactly what the ingest --voice-sample flag produces).
 * Returns the new voice id to set on the persona.
 */
export async function createVoiceClone(
  name: string,
  samples: { filename: string; data: Buffer }[],
): Promise<string> {
  const form = new FormData();
  form.append("name", name);
  for (const sample of samples) {
    form.append("files", new Blob([new Uint8Array(sample.data)], { type: "audio/mpeg" }), sample.filename);
  }
  const res = await fetch(`${BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey() },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs voice clone: ${res.status} ${await res.text()}`);
  const { voice_id } = await res.json();
  return voice_id;
}

/**
 * Start streaming one sentence with Eleven Flash v2.5. Pass the request ids
 * of the previous sentences (most recent last, up to 3 are used) so
 * ElevenLabs stitches prosody across requests instead of resetting tone.
 */
export async function ttsSentence(
  text: string,
  voiceId: string = DEFAULT_VOICE_ID,
  previousRequestIds: string[] = [],
  signal?: AbortSignal,
): Promise<TtsResult> {
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(`${BASE}/text-to-speech/${voiceId}/stream?output_format=pcm_24000`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      "Content-Type": "application/json",
      Accept: "audio/pcm",
    },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      previous_request_ids: previousRequestIds.slice(-3),
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`ElevenLabs TTS: ${res.status} ${await res.text()}`);
  }
  return {
    stream: res.body,
    requestId: res.headers.get("request-id") ?? undefined,
    servingRegion:
      res.headers.get("x-region") ?? res.headers.get("x-serving-region") ?? undefined,
    model: TTS_MODEL,
    format: "pcm_s16le",
    sampleRate: 24_000,
    channels: 1,
  };
}
