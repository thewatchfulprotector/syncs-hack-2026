import { describe, expect, it } from "vitest";
import { chunkUnits, estimateTokens, textToUnits, type ChunkUnit } from "./chunker";

function wordUnit(word: string, i: number): ChunkUnit {
  return { text: word, startMs: i * 1000, endMs: i * 1000 + 900 };
}

describe("estimateTokens", () => {
  it("approximates tokens at ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("chunkUnits", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkUnits([])).toEqual([]);
    expect(chunkUnits([{ text: "  " }])).toEqual([]);
  });

  it("puts a short input into a single chunk with its timestamps", () => {
    const chunks = chunkUnits([
      { text: "Hello there.", startMs: 0, endMs: 1200 },
      { text: "General Kenobi.", startMs: 1300, endMs: 2500 },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Hello there. General Kenobi.");
    expect(chunks[0].startMs).toBe(0);
    expect(chunks[0].endMs).toBe(2500);
  });

  it("keeps every chunk within the token budget", () => {
    const units = Array.from({ length: 200 }, (_, i) =>
      wordUnit(`sentence number ${i} with a handful of ordinary words in it.`, i),
    );
    const chunks = chunkUnits(units, { maxTokens: 400, overlapTokens: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(400);
    }
  });

  it("fills chunks decently full rather than fragmenting", () => {
    const units = Array.from({ length: 200 }, (_, i) =>
      wordUnit(`sentence number ${i} with a handful of ordinary words in it.`, i),
    );
    const chunks = chunkUnits(units, { maxTokens: 400, overlapTokens: 60 });
    for (const chunk of chunks.slice(0, -1)) {
      expect(estimateTokens(chunk.text)).toBeGreaterThan(200);
    }
  });

  it("starts each chunk with overlap from the previous one", () => {
    const units = Array.from({ length: 100 }, (_, i) =>
      wordUnit(`unit ${i} padded with some extra words for size.`, i),
    );
    const chunks = chunkUnits(units, { maxTokens: 200, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].text.slice(-40);
      // the tail of the previous chunk reappears inside the start of this one
      expect(chunks[i].text.slice(0, 200)).toContain(prevTail.split(" ").at(-2));
    }
  });

  it("covers every unit in order without gaps", () => {
    const units = Array.from({ length: 50 }, (_, i) => wordUnit(`unique-marker-${i}`, i));
    const chunks = chunkUnits(units, { maxTokens: 60, overlapTokens: 10 });
    const joined = chunks.map((c) => c.text).join(" ");
    for (let i = 0; i < 50; i++) {
      expect(joined).toContain(`unique-marker-${i}`);
    }
    // markers appear in order within the concatenation
    const positions = Array.from({ length: 50 }, (_, i) => joined.indexOf(`unique-marker-${i}`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("hard-splits a single unit that exceeds the budget", () => {
    const giant = {
      text: Array.from({ length: 500 }, (_, i) => `word${i}`).join(" "),
      startMs: 0,
      endMs: 60000,
    };
    const chunks = chunkUnits([giant], { maxTokens: 100, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(100);
      expect(chunk.startMs).toBe(0);
      expect(chunk.endMs).toBe(60000);
    }
    expect(chunks.map((c) => c.text).join(" ")).toContain("word499");
  });

  it("leaves timestamps undefined for plain-text units", () => {
    const chunks = chunkUnits([{ text: "Just some document text." }]);
    expect(chunks[0].startMs).toBeUndefined();
    expect(chunks[0].endMs).toBeUndefined();
  });
});

describe("textToUnits", () => {
  it("splits a document into trimmed paragraph units", () => {
    const doc = "First paragraph.\n\nSecond one\nstill second.\n\n\n  \n\nThird.";
    expect(textToUnits(doc)).toEqual([
      { text: "First paragraph." },
      { text: "Second one still second." },
      { text: "Third." },
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(textToUnits("   \n \n ")).toEqual([]);
  });
});
