/**
 * Gate between STT end-of-turn and question submission. The endpointing model
 * finalizes a lone vocative ("Steve") as a complete turn, so a natural pause
 * after addressing the persona would submit the name as the whole question and
 * mute the mic for the rest of it. Short address-like turns are held and merged
 * with the continuation; the caller owns the flush timer that bounds how long a
 * genuinely complete short turn waits.
 */
const FILLER_WORDS = new Set(["hey", "hi", "hello", "ok", "okay", "so", "um", "uh"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when a finalized turn looks like an address or fragment, not a question. */
export function shouldHoldTurn(text: string, personaName: string): boolean {
  const spoken = words(text);
  if (spoken.length === 0) return false;
  if (spoken.length <= 2) return true;
  const name = new Set(words(personaName));
  return spoken.every((word) => name.has(word) || FILLER_WORDS.has(word));
}

/** Merge a held address with the follow-up turn into one question. */
export function mergeHeldTurn(held: string, next: string): string {
  const left = held.trim().replace(/[,.!?]+$/, "");
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}, ${right}`;
}
