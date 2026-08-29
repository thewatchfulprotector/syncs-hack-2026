import type { AAIUtterance } from "./diarization";

export type VoiceSegment = { startMs: number; endMs: number };

export type VoiceSampleOptions = {
  /** Ignore utterances shorter than this — too clipped to clone from. */
  minMs?: number;
  /** Stop selecting once this much audio is gathered. */
  targetTotalMs?: number;
};

/**
 * Pick the persona's cleanest solo-speech segments for the ElevenLabs instant
 * voice clone: highest transcription confidence first (a proxy for clean,
 * unmuddled audio), until we have enough material. Returned in chronological
 * order so the concatenated sample sounds natural.
 */
export function selectVoiceSampleSegments(
  utterances: AAIUtterance[],
  options: VoiceSampleOptions = {},
): VoiceSegment[] {
  const minMs = options.minMs ?? 5000;
  const targetTotalMs = options.targetTotalMs ?? 90000;

  const candidates = utterances
    .filter((u) => u.end - u.start >= minMs)
    .sort(
      (a, b) =>
        (b.confidence ?? 0) - (a.confidence ?? 0) || b.end - b.start - (a.end - a.start),
    );

  const picked: AAIUtterance[] = [];
  let total = 0;
  for (const u of candidates) {
    if (total >= targetTotalMs) break;
    picked.push(u);
    total += u.end - u.start;
  }

  return picked
    .sort((a, b) => a.start - b.start)
    .map((u) => ({ startMs: u.start, endMs: u.end }));
}
