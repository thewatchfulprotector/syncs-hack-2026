import type { AAIUtterance } from "./diarization";

export type VoiceSegment = { startMs: number; endMs: number };

export type VoiceSampleSource = {
  sourceFile: string;
  utterances: AAIUtterance[];
};

export type SourceVoiceSegment = VoiceSegment & { sourceFile: string };

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
  return selectVoiceSampleSegmentsAcrossSources(
    [{ sourceFile: "", utterances }],
    options,
  ).map(({ startMs, endMs }) => ({ startMs, endMs }));
}

/**
 * Select the cleanest eligible utterances across every source against one
 * global duration budget. The result is restored to source/timestamp order so
 * concatenated clips remain deterministic and natural within each recording.
 */
export function selectVoiceSampleSegmentsAcrossSources(
  sources: VoiceSampleSource[],
  options: VoiceSampleOptions = {},
): SourceVoiceSegment[] {
  const minMs = options.minMs ?? 5000;
  const targetTotalMs = options.targetTotalMs ?? 90000;

  const candidates = sources
    .flatMap((source, sourceIndex) =>
      source.utterances.map((utterance, utteranceIndex) => ({
        sourceFile: source.sourceFile,
        sourceIndex,
        utteranceIndex,
        utterance,
      })),
    )
    .filter(({ utterance }) => utterance.end - utterance.start >= minMs)
    .sort(
      (a, b) =>
        (b.utterance.confidence ?? 0) - (a.utterance.confidence ?? 0) ||
        b.utterance.end - b.utterance.start - (a.utterance.end - a.utterance.start) ||
        a.sourceIndex - b.sourceIndex ||
        a.utterance.start - b.utterance.start ||
        a.utteranceIndex - b.utteranceIndex,
    );

  const picked: typeof candidates = [];
  let total = 0;
  for (const candidate of candidates) {
    if (total >= targetTotalMs) break;
    picked.push(candidate);
    total += candidate.utterance.end - candidate.utterance.start;
  }

  return picked
    .sort(
      (a, b) =>
        a.sourceIndex - b.sourceIndex ||
        a.utterance.start - b.utterance.start ||
        a.utteranceIndex - b.utteranceIndex,
    )
    .map(({ sourceFile, utterance }) => ({
      sourceFile,
      startMs: utterance.start,
      endMs: utterance.end,
    }));
}
