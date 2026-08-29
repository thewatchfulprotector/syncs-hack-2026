function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Detect the persona's own played-back speech re-entering through the mic.
 * Browser echo cancellation does not reliably cancel Web Audio output (notably
 * on macOS speakers), so without this a spoken answer becomes the next
 * "question" and the conversation talks to itself.
 *
 * A transcript counts as echo when it is at least three words long and its
 * words appear as a contiguous run in what was recently spoken aloud.
 */
export function isLikelyEcho(transcript: string, recentSpeech: string): boolean {
  const candidate = normalize(transcript);
  if (candidate.length < 3) return false;
  const spoken = normalize(recentSpeech);
  if (spoken.length === 0) return false;
  const needle = candidate.join(" ");
  const haystack = spoken.join(" ");
  return haystack.includes(needle);
}
