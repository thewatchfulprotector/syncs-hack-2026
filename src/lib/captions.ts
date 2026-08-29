/**
 * Split a spoken sentence into caption lines of roughly 6-10 words, breaking
 * after mid-sentence punctuation when one lands near the boundary and never
 * orphaning a tiny tail. Ported from the Voice Orb design.
 */
export function chunkSentence(sentence: string, maxWords = 10): string[] {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  const n = words.length;
  const max = Math.max(3, Math.floor(maxWords));
  if (n === 0) return [];
  if (n <= max) return [words.join(" ")];
  const k = Math.ceil(n / max);
  const target = Math.ceil(n / k);
  const chunks: string[] = [];
  let i = 0;
  while (i < n) {
    let take = Math.min(target, n - i);
    if (i + take < n) {
      for (const off of [0, -1, 1]) {
        const idx = i + take - 1 + off;
        if (idx > i && idx < n - 1 && /[,;:—-]$/.test(words[idx])) {
          take = idx - i + 1;
          break;
        }
      }
    }
    const rest = n - (i + take);
    if (rest > 0 && rest < 4 && take + rest <= max + 1) take += rest;
    chunks.push(words.slice(i, i + take).join(" "));
    i += take;
  }
  return chunks;
}

/** The last `n` words of a running transcript, for the one-line live caption. */
export function tailWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(-n).join(" ");
}
