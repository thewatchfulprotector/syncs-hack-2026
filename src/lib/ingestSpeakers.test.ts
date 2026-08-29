import { describe, expect, it } from "vitest";
import type { AAIUtterance } from "./diarization";
import {
  parseSpeakerAssignments,
  selectSpeakerForFile,
  summarizeSpeakers,
} from "./ingestSpeakers";

function utterance(
  speaker: string,
  start: number,
  end: number,
  text: string,
): AAIUtterance {
  return { speaker, start, end, text, words: [] };
}

const mixedSpeakers = [
  utterance("A", 0, 2_000, "A brief opening"),
  utterance("B", 2_500, 7_500, "B explains the main idea"),
  utterance("A", 8_000, 11_000, "A asks a follow-up"),
  utterance("B", 12_000, 13_000, "B gives a short answer"),
];

describe("summarizeSpeakers", () => {
  it("sorts speakers by total duration and includes timestamped excerpts", () => {
    expect(summarizeSpeakers(mixedSpeakers, 2)).toEqual([
      {
        speaker: "B",
        utteranceCount: 2,
        durationMs: 6_000,
        share: 6 / 11,
        excerpts: [
          {
            text: "B explains the main idea",
            startMs: 2_500,
            endMs: 7_500,
          },
          {
            text: "B gives a short answer",
            startMs: 12_000,
            endMs: 13_000,
          },
        ],
      },
      {
        speaker: "A",
        utteranceCount: 2,
        durationMs: 5_000,
        share: 5 / 11,
        excerpts: [
          {
            text: "A asks a follow-up",
            startMs: 8_000,
            endMs: 11_000,
          },
          {
            text: "A brief opening",
            startMs: 0,
            endMs: 2_000,
          },
        ],
      },
    ]);
  });

  it("is deterministic for the same utterances in a different input order", () => {
    expect(summarizeSpeakers([...mixedSpeakers].reverse(), 2)).toEqual(
      summarizeSpeakers(mixedSpeakers, 2),
    );
  });

  it("uses the speaker label to break equal-duration ties", () => {
    const tied = [
      utterance("B", 0, 1_000, "from B"),
      utterance("A", 2_000, 3_000, "from A"),
    ];

    expect(summarizeSpeakers(tied, 1).map((summary) => summary.speaker)).toEqual([
      "A",
      "B",
    ]);
  });

  it("limits representative excerpts without changing aggregate counts", () => {
    const [summary] = summarizeSpeakers(
      [
        utterance("A", 0, 1_000, "short"),
        utterance("A", 2_000, 6_000, "longest"),
        utterance("A", 7_000, 9_000, "medium"),
      ],
      1,
    );

    expect(summary).toMatchObject({
      utteranceCount: 3,
      durationMs: 7_000,
      share: 1,
      excerpts: [{ text: "longest", startMs: 2_000, endMs: 6_000 }],
    });
  });
});

describe("parseSpeakerAssignments", () => {
  it("parses repeated source=label entries", () => {
    expect(
      parseSpeakerAssignments([
        "media/elon/first.mp3=A",
        "second episode.mp3=B",
      ]),
    ).toEqual(
      new Map([
        ["media/elon/first.mp3", "A"],
        ["second episode.mp3", "B"],
      ]),
    );
  });

  it.each(["first.mp3", "=A", "first.mp3=", "first.mp3=A=unexpected"])(
    "rejects malformed assignment %j",
    (entry) => {
      expect(() => parseSpeakerAssignments([entry])).toThrow(/source=label/i);
    },
  );

  it("rejects duplicate source entries", () => {
    expect(() =>
      parseSpeakerAssignments(["first.mp3=A", "first.mp3=B"]),
    ).toThrow(/duplicate.*first\.mp3/i);
  });
});

describe("selectSpeakerForFile", () => {
  it("gives an exact per-file assignment precedence over basename and global values", () => {
    const result = selectSpeakerForFile("media/elon/episode.mp3", mixedSpeakers, {
      assignments: new Map([
        ["episode.mp3", "A"],
        ["media/elon/episode.mp3", "B"],
      ]),
      speaker: "A",
    });

    expect(result).toEqual({ speaker: "B", source: "per-file" });
  });

  it("accepts a basename per-file assignment before the global value", () => {
    const result = selectSpeakerForFile("media/elon/episode.mp3", mixedSpeakers, {
      assignments: new Map([["episode.mp3", "B"]]),
      speaker: "A",
    });

    expect(result).toEqual({ speaker: "B", source: "per-file" });
  });

  it("uses the global speaker when no per-file assignment matches", () => {
    const result = selectSpeakerForFile("media/elon/episode.mp3", mixedSpeakers, {
      assignments: new Map([["other.mp3", "B"]]),
      speaker: "A",
    });

    expect(result).toEqual({ speaker: "A", source: "global" });
  });

  it.each([
    {
      name: "per-file",
      options: { assignments: new Map([["episode.mp3", "Z"]]) },
    },
    { name: "global", options: { speaker: "Z" } },
  ])("rejects a missing $name speaker label", ({ options }) => {
    expect(() =>
      selectSpeakerForFile("media/elon/episode.mp3", mixedSpeakers, options),
    ).toThrow(/speaker.*Z.*not found/i);
  });

  it("automatically selects the only speaker in a file", () => {
    const oneSpeaker = [
      utterance("E", 0, 2_000, "first"),
      utterance("E", 3_000, 6_000, "second"),
    ];

    expect(selectSpeakerForFile("solo.mp3", oneSpeaker, {})).toEqual({
      speaker: "E",
      source: "single-speaker",
    });
  });

  it("refuses to guess when a file contains multiple speakers", () => {
    expect(() =>
      selectSpeakerForFile("episode.mp3", mixedSpeakers, {}),
    ).toThrow(/multiple speakers.*episode\.mp3/i);
  });

  it("selects the dominant speaker only when explicitly allowed", () => {
    expect(
      selectSpeakerForFile("episode.mp3", mixedSpeakers, {
        allowDominant: true,
      }),
    ).toEqual({ speaker: "B", source: "dominant" });
  });

  it("rejects a transcript with no utterances", () => {
    expect(() => selectSpeakerForFile("empty.mp3", [], {})).toThrow(
      /no speakers.*empty\.mp3/i,
    );
  });
});
