import { describe, expect, it } from "vitest";
import { chunkSentence, tailWords } from "./captions";

describe("chunkSentence", () => {
  it("keeps a short sentence as one chunk", () => {
    expect(chunkSentence("Stay hungry, stay foolish.")).toEqual(["Stay hungry, stay foolish."]);
  });

  it("splits a long sentence into caption-sized lines", () => {
    const sentence =
      "The first story is about connecting the dots and how dropping out of Reed College turned out to be one of the best decisions I ever made in my life.";
    const chunks = chunkSentence(sentence);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const words = chunk.split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(4);
      expect(words).toBeLessThanOrEqual(11);
    }
    expect(chunks.join(" ")).toBe(sentence);
  });

  it("prefers breaking after punctuation near the boundary", () => {
    const sentence =
      "Well, there's a couple of things happening here, and the season has been pretty dry already this year.";
    const chunks = chunkSentence(sentence);
    expect(chunks.some((c) => c.endsWith(","))).toBe(true);
  });

  it("absorbs a tiny trailing fragment instead of orphaning it", () => {
    const sentence = "one two three four five six seven eight nine ten eleven twelve";
    const chunks = chunkSentence(sentence);
    const last = chunks.at(-1)!.split(/\s+/).length;
    expect(last).toBeGreaterThanOrEqual(4);
  });

  it("handles empty input", () => {
    expect(chunkSentence("   ")).toEqual([]);
  });

  it("caps every chunk at the given word budget (plus merged tiny tail)", () => {
    const sentence =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    const chunks = chunkSentence(sentence, 6);
    for (const chunk of chunks) {
      expect(chunk.split(/\s+/).length).toBeLessThanOrEqual(7);
    }
    expect(chunks.join(" ")).toBe(sentence);
  });

  it("keeps a sentence within the budget as one chunk", () => {
    expect(chunkSentence("one two three four five", 6)).toEqual(["one two three four five"]);
  });
});

describe("tailWords", () => {
  it("returns the whole text when short", () => {
    expect(tailWords("just a few words", 10)).toBe("just a few words");
  });

  it("keeps only the last n words when long", () => {
    expect(tailWords("a b c d e f g h i j k l", 4)).toBe("i j k l");
  });
});
