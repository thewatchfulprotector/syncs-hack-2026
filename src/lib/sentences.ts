const BOUNDARY = /([.!?]+["')\]]*)(\s+)/g;
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|approx|e\.g|i\.e)\.$/i;

/**
 * Incremental sentence splitter for a token stream: push tokens as they
 * arrive, get back completed sentences to hand to TTS. A sentence is complete
 * once its terminal punctuation is followed by whitespace (so decimals like
 * "2.5" never split), with a guard for common abbreviations.
 */
export class SentenceSplitter {
  private buffer = "";

  push(token: string): string[] {
    this.buffer += token;
    const sentences: string[] = [];
    let cut = 0;
    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(this.buffer); m !== null; m = BOUNDARY.exec(this.buffer)) {
      const end = m.index + m[1].length;
      const candidate = this.buffer.slice(cut, end);
      if (ABBREVIATION.test(candidate)) continue;
      const trimmed = candidate.trim();
      if (trimmed.length > 0) sentences.push(trimmed);
      cut = end + m[2].length;
    }
    this.buffer = this.buffer.slice(cut);
    return sentences;
  }

  /** Return whatever is left (or null) and reset. Call once the stream ends. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }
}
