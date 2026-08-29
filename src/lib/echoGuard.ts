function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function editDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Detect the persona's own played-back speech re-entering through the mic.
 * Browser echo cancellation does not reliably cancel Web Audio output (notably
 * on macOS speakers), so without this a spoken answer becomes the next
 * "question" and the conversation talks to itself.
 *
 * Short replies are too ambiguous to suppress. Longer transcripts count as
 * echo when they match a recent contiguous word sequence exactly, or differ
 * only by the small substitution/omission errors typical of live STT.
 */
export function isLikelyEcho(transcript: string, recentSpeech: string): boolean {
  const candidate = normalize(transcript);
  if (candidate.length < 4) return false;
  const spoken = normalize(recentSpeech);
  if (spoken.length === 0) return false;
  for (let start = 0; start + candidate.length <= spoken.length; start++) {
    if (candidate.every((word, index) => word === spoken[start + index])) return true;
  }

  // Keep four-word turns exact-only. One error in such a short phrase is too
  // permissive and can swallow an ordinary user response.
  if (candidate.length < 5) return false;
  const maxDistance = Math.max(1, Math.floor(candidate.length * 0.2));
  for (const windowLength of [candidate.length - 1, candidate.length, candidate.length + 1]) {
    if (windowLength < 1 || windowLength > spoken.length) continue;
    for (let start = 0; start + windowLength <= spoken.length; start++) {
      if (editDistance(candidate, spoken.slice(start, start + windowLength)) <= maxDistance) {
        return true;
      }
    }
  }
  return false;
}
