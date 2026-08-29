import { describe, expect, it } from "vitest";
import transcript from "./fixtures/assemblyai-transcript.json";
import {
  dominantSpeaker,
  filterPersonaUtterances,
  utterancesToUnits,
  type AAIUtterance,
} from "./diarization";

const utterances = transcript.utterances as AAIUtterance[];

describe("dominantSpeaker", () => {
  it("picks the speaker with the most total speaking time", () => {
    // in the fixture the interviewee (B) talks ~181s vs the host's ~95s
    expect(dominantSpeaker(utterances)).toBe("B");
  });

  it("throws on an empty transcript", () => {
    expect(() => dominantSpeaker([])).toThrow();
  });
});

describe("filterPersonaUtterances", () => {
  it("keeps only the dominant speaker by default", () => {
    const kept = filterPersonaUtterances(utterances);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((u) => u.speaker === "B")).toBe(true);
    expect(kept.length).toBe(utterances.filter((u) => u.speaker === "B").length);
  });

  it("honours an explicit speaker override", () => {
    const kept = filterPersonaUtterances(utterances, "A");
    expect(kept.length).toBe(utterances.filter((u) => u.speaker === "A").length);
    expect(kept.every((u) => u.speaker === "A")).toBe(true);
  });

  it("preserves source order", () => {
    const kept = filterPersonaUtterances(utterances);
    const starts = kept.map((u) => u.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe("utterancesToUnits", () => {
  it("splits words into sentence units with word-accurate timestamps", () => {
    const utterance: AAIUtterance = {
      speaker: "B",
      text: "Hello there. General Kenobi!",
      start: 100,
      end: 2600,
      words: [
        { text: "Hello", start: 100, end: 500, speaker: "B" },
        { text: "there.", start: 600, end: 1000, speaker: "B" },
        { text: "General", start: 1500, end: 1900, speaker: "B" },
        { text: "Kenobi!", start: 2000, end: 2600, speaker: "B" },
      ],
    };
    expect(utterancesToUnits([utterance])).toEqual([
      { text: "Hello there.", startMs: 100, endMs: 1000 },
      { text: "General Kenobi!", startMs: 1500, endMs: 2600 },
    ]);
  });

  it("keeps an unpunctuated run of words as one unit", () => {
    const utterance: AAIUtterance = {
      speaker: "B",
      text: "no punctuation here",
      start: 0,
      end: 900,
      words: [
        { text: "no", start: 0, end: 200, speaker: "B" },
        { text: "punctuation", start: 300, end: 600, speaker: "B" },
        { text: "here", start: 700, end: 900, speaker: "B" },
      ],
    };
    expect(utterancesToUnits([utterance])).toEqual([
      { text: "no punctuation here", startMs: 0, endMs: 900 },
    ]);
  });

  it("loses no words from the real fixture and stays in order", () => {
    const persona = filterPersonaUtterances(utterances);
    const units = utterancesToUnits(persona);
    expect(units.length).toBeGreaterThanOrEqual(persona.length);
    const unitWordCount = units
      .map((u) => u.text.split(/\s+/).length)
      .reduce((a, b) => a + b, 0);
    const sourceWordCount = persona.map((u) => u.words.length).reduce((a, b) => a + b, 0);
    expect(unitWordCount).toBe(sourceWordCount);
    for (const unit of units) {
      expect(unit.text.length).toBeGreaterThan(0);
      expect(unit.startMs).toBeLessThanOrEqual(unit.endMs!);
    }
    const starts = units.map((u) => u.startMs!);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});
