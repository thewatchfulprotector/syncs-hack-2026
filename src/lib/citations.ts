export type ExtractedAnswer = {
  answer: string;
  /** 1-indexed excerpt numbers the model says it drew on. */
  sources: number[];
  /**
   * Whether a SOURCES line was present at all. An explicit empty line means
   * "drew on nothing" (small talk — show no citations); a missing line means
   * the model glitched, so callers may fall back to showing everything.
   */
  hasSourcesLine: boolean;
};

// models sometimes ignore "on its own line", so any whitespace before SOURCES counts
const SOURCES_LINE = /[\n\s]\s*SOURCES:\s*\[?([\d\s,-]*)\]?\s*$/;

/**
 * Split the model's trailing "SOURCES: 1,3" metadata line from the spoken
 * answer. The line is only recognised at the very end of the text.
 */
export function extractSources(text: string): ExtractedAnswer {
  const match = text.match(SOURCES_LINE);
  if (!match) return { answer: text, sources: [], hasSourcesLine: false };
  const sources = [
    ...new Set(
      match[1]
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
  return { answer: text.slice(0, match.index).trimEnd(), sources, hasSourcesLine: true };
}

/**
 * Display-trim a partially streamed answer: drop a trailing SOURCES line even
 * while it is still arriving token by token, so it never flashes on screen.
 */
export function stripStreamingSourcesTail(text: string): string {
  const extracted = extractSources(text);
  if (extracted.hasSourcesLine) return extracted.answer;
  // greedy prefix: the tail starts at the LAST whitespace-preceded capital S
  const match = text.match(/^([\S\s]*)[\n\s](S[\S\s]*)$/);
  if (!match) return text;
  const tail = match[2];
  if ("SOURCES:".startsWith(tail) || /^SOURCES:\s*\[?[\d\s,-]*$/.test(tail)) {
    return match[1].trimEnd();
  }
  return text;
}
