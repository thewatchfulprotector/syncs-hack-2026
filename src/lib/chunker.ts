export type ChunkUnit = {
  text: string;
  startMs?: number;
  endMs?: number;
};

export type Chunk = {
  text: string;
  startMs?: number;
  endMs?: number;
};

export type ChunkOptions = {
  maxTokens?: number;
  overlapTokens?: number;
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Split a single oversized unit into word-level pieces that fit the budget. */
function splitOversized(unit: ChunkUnit, maxTokens: number): ChunkUnit[] {
  const words = unit.text.split(/\s+/).filter(Boolean);
  const pieces: ChunkUnit[] = [];
  let current: string[] = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      pieces.push({ text: current.join(" "), startMs: unit.startMs, endMs: unit.endMs });
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) {
    pieces.push({ text: current.join(" "), startMs: unit.startMs, endMs: unit.endMs });
  }
  return pieces;
}

/**
 * Greedily pack units into chunks of at most `maxTokens` (estimated), seeding
 * each new chunk with the trailing units of the previous one up to
 * `overlapTokens`. Units bigger than the budget are hard-split by words.
 */
export function chunkUnits(units: ChunkUnit[], options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 400;
  const overlapTokens = Math.min(options.overlapTokens ?? 60, Math.floor(maxTokens / 2));

  const normalized = units
    .map((u) => ({ ...u, text: u.text.trim() }))
    .filter((u) => u.text.length > 0)
    .flatMap((u) => (estimateTokens(u.text) > maxTokens ? splitOversized(u, maxTokens) : [u]));

  const chunks: Chunk[] = [];
  let current: ChunkUnit[] = [];
  let currentTokens = 0;
  // units carried over as overlap; they must not trigger another emit on their own
  let overlapCount = 0;

  const emit = () => {
    const fresh = current.slice(overlapCount);
    if (fresh.length === 0) return; // nothing new beyond the overlap seed
    const text = current.map((u) => u.text).join(" ");
    chunks.push({
      text,
      startMs: current.find((u) => u.startMs !== undefined)?.startMs,
      endMs: [...current].reverse().find((u) => u.endMs !== undefined)?.endMs,
    });
  };

  for (const unit of normalized) {
    const unitTokens = estimateTokens(unit.text);
    if (current.length > 0 && currentTokens + unitTokens > maxTokens) {
      emit();
      // seed the next chunk with trailing units up to the overlap budget
      const seed: ChunkUnit[] = [];
      let seedTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const t = estimateTokens(current[i].text);
        if (seedTokens + t > overlapTokens) break;
        seed.unshift(current[i]);
        seedTokens += t;
      }
      current = seed;
      currentTokens = seedTokens;
      overlapCount = seed.length;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  emit();

  return chunks;
}

/** Split a plain-text document into paragraph units (blank-line separated). */
export function textToUnits(text: string): ChunkUnit[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ text: p }));
}
