import { basename } from "node:path";
import { dominantSpeaker, type AAIUtterance } from "./diarization";

export type SpeakerExcerpt = {
  text: string;
  startMs: number;
  endMs: number;
};

export type SpeakerSummary = {
  speaker: string;
  utteranceCount: number;
  durationMs: number;
  share: number;
  excerpts: SpeakerExcerpt[];
};

export type SpeakerSelection = {
  speaker: string;
  source: "per-file" | "global" | "single-speaker" | "dominant";
};

export type SpeakerSelectionOptions = {
  assignments?: ReadonlyMap<string, string>;
  speaker?: string;
  allowDominant?: boolean;
};

/**
 * Build a deterministic review summary for each diarized speaker. Long
 * utterances make better identity excerpts than greetings or backchannels.
 */
export function summarizeSpeakers(
  utterances: AAIUtterance[],
  maxExcerpts = 3,
): SpeakerSummary[] {
  if (!Number.isInteger(maxExcerpts) || maxExcerpts < 0) {
    throw new Error("maxExcerpts must be a non-negative integer");
  }

  const groups = new Map<string, AAIUtterance[]>();
  for (const utterance of utterances) {
    const existing = groups.get(utterance.speaker) ?? [];
    existing.push(utterance);
    groups.set(utterance.speaker, existing);
  }

  const totalDurationMs = utterances.reduce(
    (total, utterance) => total + Math.max(0, utterance.end - utterance.start),
    0,
  );

  return [...groups.entries()]
    .map(([speaker, speakerUtterances]) => {
      const durationMs = speakerUtterances.reduce(
        (total, utterance) => total + Math.max(0, utterance.end - utterance.start),
        0,
      );
      const excerpts = [...speakerUtterances]
        .sort(
          (a, b) =>
            b.end - b.start - (a.end - a.start) ||
            a.start - b.start ||
            a.text.localeCompare(b.text),
        )
        .slice(0, maxExcerpts)
        .map((utterance) => ({
          text: utterance.text,
          startMs: utterance.start,
          endMs: utterance.end,
        }));

      return {
        speaker,
        utteranceCount: speakerUtterances.length,
        durationMs,
        share: totalDurationMs === 0 ? 0 : durationMs / totalDurationMs,
        excerpts,
      };
    })
    .sort((a, b) => b.durationMs - a.durationMs || a.speaker.localeCompare(b.speaker));
}

/** Parse repeatable CLI values in the exact form `source=label`. */
export function parseSpeakerAssignments(entries: string[]): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    const firstEquals = entry.indexOf("=");
    if (
      firstEquals <= 0 ||
      firstEquals !== entry.lastIndexOf("=") ||
      firstEquals === entry.length - 1
    ) {
      throw new Error(`invalid speaker assignment "${rawEntry}"; expected source=label`);
    }

    const source = entry.slice(0, firstEquals).trim();
    const speaker = entry.slice(firstEquals + 1).trim();
    if (!source || !speaker) {
      throw new Error(`invalid speaker assignment "${rawEntry}"; expected source=label`);
    }
    if (assignments.has(source)) {
      throw new Error(`duplicate speaker assignment for ${source}`);
    }
    assignments.set(source, speaker);
  }
  return assignments;
}

/**
 * Resolve one file's persona speaker without silently guessing on a
 * multi-speaker recording. Exact path mappings beat basename mappings.
 */
export function selectSpeakerForFile(
  file: string,
  utterances: AAIUtterance[],
  options: SpeakerSelectionOptions = {},
): SpeakerSelection {
  const speakers = [...new Set(utterances.map((utterance) => utterance.speaker))].sort();
  if (speakers.length === 0) throw new Error(`no speakers found in ${file}`);

  const exact = options.assignments?.get(file);
  const byBasename = options.assignments?.get(basename(file));
  const selected = exact ?? byBasename ?? options.speaker;
  const source = exact !== undefined || byBasename !== undefined ? "per-file" : "global";

  if (selected !== undefined) {
    if (!speakers.includes(selected)) {
      throw new Error(`speaker ${selected} not found in ${file}; available: ${speakers.join(", ")}`);
    }
    return { speaker: selected, source };
  }

  if (speakers.length === 1) {
    return { speaker: speakers[0], source: "single-speaker" };
  }
  if (options.allowDominant) {
    return { speaker: dominantSpeaker(utterances), source: "dominant" };
  }

  throw new Error(
    `multiple speakers found in ${file} (${speakers.join(", ")}); review them and pass --speaker-for "${basename(file)}=<label>"`,
  );
}
