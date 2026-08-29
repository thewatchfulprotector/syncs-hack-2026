import { describe, expect, it } from "vitest";
import transcript from "./fixtures/assemblyai-transcript.json";
import { filterPersonaUtterances, type AAIUtterance } from "./diarization";
import { selectVoiceSampleSegments } from "./voiceSample";

function utterance(
  start: number,
  end: number,
  confidence: number,
  speaker = "B",
): AAIUtterance {
  return { speaker, text: "x", start, end, confidence, words: [] };
}

describe("selectVoiceSampleSegments", () => {
  it("drops segments shorter than the minimum", () => {
    const segments = selectVoiceSampleSegments(
      [utterance(0, 2000, 0.99), utterance(3000, 12000, 0.95)],
      { minMs: 5000, targetTotalMs: 60000 },
    );
    expect(segments).toEqual([{ startMs: 3000, endMs: 12000 }]);
  });

  it("prefers higher-confidence segments when it cannot take everything", () => {
    const segments = selectVoiceSampleSegments(
      [
        utterance(0, 10000, 0.7),
        utterance(20000, 30000, 0.99),
        utterance(40000, 50000, 0.95),
      ],
      { minMs: 5000, targetTotalMs: 20000 },
    );
    expect(segments).toEqual([
      { startMs: 20000, endMs: 30000 },
      { startMs: 40000, endMs: 50000 },
    ]);
  });

  it("stops adding once the target total is reached", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      utterance(i * 20000, i * 20000 + 10000, 0.9),
    );
    const segments = selectVoiceSampleSegments(many, { minMs: 5000, targetTotalMs: 30000 });
    const total = segments.reduce((s, x) => s + (x.endMs - x.startMs), 0);
    expect(total).toBeGreaterThanOrEqual(30000);
    expect(total).toBeLessThan(50000);
  });

  it("returns segments in chronological order regardless of score", () => {
    const segments = selectVoiceSampleSegments(
      [utterance(50000, 60000, 0.99), utterance(0, 10000, 0.8), utterance(20000, 30000, 0.9)],
      { minMs: 5000, targetTotalMs: 60000 },
    );
    const starts = segments.map((s) => s.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("takes everything eligible when the source is short of the target", () => {
    const segments = selectVoiceSampleSegments(
      [utterance(0, 8000, 0.9), utterance(10000, 17000, 0.85)],
      { minMs: 5000, targetTotalMs: 120000 },
    );
    expect(segments).toHaveLength(2);
  });

  it("finds usable segments in the real fixture", () => {
    const persona = filterPersonaUtterances(
      transcript.utterances as AAIUtterance[],
    );
    const segments = selectVoiceSampleSegments(persona);
    expect(segments.length).toBeGreaterThan(0);
    const total = segments.reduce((s, x) => s + (x.endMs - x.startMs), 0);
    expect(total).toBeGreaterThan(30000); // enough audio for an instant clone
  });
});
