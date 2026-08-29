import { describe, expect, it } from "vitest";
import type { AAIUtterance } from "./diarization";
import { selectVoiceSampleSegmentsAcrossSources } from "./voiceSample";

function utterance(
  start: number,
  end: number,
  confidence: number,
  speaker = "B",
): AAIUtterance {
  return { speaker, text: "x", start, end, confidence, words: [] };
}

describe("selectVoiceSampleSegmentsAcrossSources", () => {
  it("applies one global duration target and prefers the cleanest eligible audio", () => {
    const segments = selectVoiceSampleSegmentsAcrossSources(
      [
        {
          sourceFile: "first.mp3",
          utterances: [utterance(0, 6000, 0.7)],
        },
        {
          sourceFile: "second.mp3",
          utterances: [
            utterance(0, 6000, 0.99),
            utterance(10000, 16000, 0.95),
          ],
        },
      ],
      { minMs: 5000, targetTotalMs: 12000 },
    );

    expect(segments).toEqual([
      { sourceFile: "second.mp3", startMs: 0, endMs: 6000 },
      { sourceFile: "second.mp3", startMs: 10000, endMs: 16000 },
    ]);
    expect(
      segments.reduce((total, segment) => total + segment.endMs - segment.startMs, 0),
    ).toBe(12000);
  });

  it("skips utterances shorter than the configured minimum", () => {
    const segments = selectVoiceSampleSegmentsAcrossSources(
      [
        {
          sourceFile: "interview.mp3",
          utterances: [utterance(0, 4999, 1), utterance(6000, 11000, 0.8)],
        },
      ],
      { minMs: 5000, targetTotalMs: 60000 },
    );

    expect(segments).toEqual([
      { sourceFile: "interview.mp3", startMs: 6000, endMs: 11000 },
    ]);
  });

  it("returns selected segments by input source order, then timestamp", () => {
    const segments = selectVoiceSampleSegmentsAcrossSources(
      [
        {
          sourceFile: "z-last-lexically.mp3",
          utterances: [
            utterance(20000, 26000, 0.99),
            utterance(0, 6000, 0.7),
          ],
        },
        {
          sourceFile: "a-first-lexically.mp3",
          utterances: [
            utterance(10000, 16000, 0.95),
            utterance(0, 6000, 0.8),
          ],
        },
      ],
      { minMs: 5000, targetTotalMs: 60000 },
    );

    expect(segments).toEqual([
      { sourceFile: "z-last-lexically.mp3", startMs: 0, endMs: 6000 },
      { sourceFile: "z-last-lexically.mp3", startMs: 20000, endMs: 26000 },
      { sourceFile: "a-first-lexically.mp3", startMs: 0, endMs: 6000 },
      { sourceFile: "a-first-lexically.mp3", startMs: 10000, endMs: 16000 },
    ]);
  });

  it("does not mutate source or utterance order", () => {
    const sources = [
      {
        sourceFile: "one.mp3",
        utterances: [utterance(10000, 16000, 0.99), utterance(0, 6000, 0.8)],
      },
      {
        sourceFile: "two.mp3",
        utterances: [utterance(20000, 26000, 0.9), utterance(0, 6000, 0.7)],
      },
    ];
    const before = structuredClone(sources);

    selectVoiceSampleSegmentsAcrossSources(sources, {
      minMs: 5000,
      targetTotalMs: 18000,
    });

    expect(sources).toEqual(before);
  });

  it("keeps same-timestamp segments from different source files distinct", () => {
    const segments = selectVoiceSampleSegmentsAcrossSources(
      [
        {
          sourceFile: "one.mp3",
          utterances: [utterance(0, 6000, 0.9)],
        },
        {
          sourceFile: "two.mp3",
          utterances: [utterance(0, 6000, 0.9)],
        },
      ],
      { minMs: 5000, targetTotalMs: 12000 },
    );

    expect(segments).toEqual([
      { sourceFile: "one.mp3", startMs: 0, endMs: 6000 },
      { sourceFile: "two.mp3", startMs: 0, endMs: 6000 },
    ]);
  });
});
