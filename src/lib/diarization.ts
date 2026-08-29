import type { ChunkUnit } from "./chunker";

export type AAIWord = {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: string;
};

export type AAIUtterance = {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence?: number;
  words: AAIWord[];
};

/**
 * The persona is assumed to be whoever talks most — in an interview the
 * interviewee dominates. Override with an explicit speaker label when the
 * heuristic is wrong for a given source.
 */
export function dominantSpeaker(utterances: AAIUtterance[]): string {
  if (utterances.length === 0) throw new Error("no utterances in transcript");
  const totals = new Map<string, number>();
  for (const u of utterances) {
    totals.set(u.speaker, (totals.get(u.speaker) ?? 0) + (u.end - u.start));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Keep only the persona's own speech, so the index never absorbs the interviewer. */
export function filterPersonaUtterances(
  utterances: AAIUtterance[],
  speaker?: string,
): AAIUtterance[] {
  const persona = speaker ?? dominantSpeaker(utterances);
  return utterances.filter((u) => u.speaker === persona);
}

/**
 * Convert utterances into sentence-level chunk units, using word timestamps so
 * each unit's range points at the exact moment in the source media.
 */
export function utterancesToUnits(utterances: AAIUtterance[]): ChunkUnit[] {
  const units: ChunkUnit[] = [];
  for (const utterance of utterances) {
    let words: AAIWord[] = [];
    const flush = () => {
      if (words.length === 0) return;
      units.push({
        text: words.map((w) => w.text).join(" "),
        startMs: words[0].start,
        endMs: words[words.length - 1].end,
      });
      words = [];
    };
    for (const word of utterance.words) {
      words.push(word);
      if (/[.!?]["')\]]?$/.test(word.text)) flush();
    }
    flush();
  }
  return units;
}
