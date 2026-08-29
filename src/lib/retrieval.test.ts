import { describe, expect, it } from "vitest";
import fixture from "./fixtures/pinecone-query.json";
import { parseMatches } from "./retrieval";

describe("parseMatches", () => {
  it("parses a real Pinecone query response into typed chunks", () => {
    const chunks = parseMatches(fixture);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^wildfire-expert:/);
      expect(chunk.score).toBeGreaterThan(0);
      expect(chunk.metadata.text.length).toBeGreaterThan(0);
      expect(chunk.metadata.persona_id).toBe("wildfire-expert");
      expect(chunk.metadata.source_file).toBe("wildfires.mp3");
      expect(chunk.metadata.media_type).toBe("audio");
      expect(chunk.metadata.speaker).toBe("B");
      expect(chunk.metadata.start_ms).toBeTypeOf("number");
      expect(chunk.metadata.end_ms).toBeTypeOf("number");
    }
  });

  it("orders chunks by score, best first", () => {
    const scores = parseMatches(fixture).map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("drops matches with missing or textless metadata", () => {
    const chunks = parseMatches({
      matches: [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8, metadata: { persona_id: "x" } },
        {
          id: "c",
          score: 0.7,
          metadata: {
            persona_id: "x",
            source_file: "f.mp3",
            media_type: "audio",
            text: "kept",
          },
        },
      ],
    });
    expect(chunks.map((c) => c.id)).toEqual(["c"]);
  });

  it("handles an empty response", () => {
    expect(parseMatches({})).toEqual([]);
    expect(parseMatches({ matches: [] })).toEqual([]);
  });
});
