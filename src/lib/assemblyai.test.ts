import { describe, expect, it } from "vitest";
import fixture from "./fixtures/assemblyai-transcript.json";
import { parseTranscript } from "./assemblyai";

describe("parseTranscript", () => {
  it("accepts a real completed transcript payload", () => {
    const transcript = parseTranscript(fixture);
    expect(transcript.id).toBe(fixture.id);
    expect(transcript.audio_duration).toBe(fixture.audio_duration);
    expect(transcript.utterances).toHaveLength(fixture.utterances.length);
    expect(transcript.utterances[0].words[0].start).toBeTypeOf("number");
  });

  it("rejects a completed payload whose diarization came back null", () => {
    expect(() => parseTranscript({ ...fixture, utterances: null })).toThrowError(
      /utterances/,
    );
  });

  it("rejects a payload missing a required field, naming the field", () => {
    const withoutText: Record<string, unknown> = { ...fixture };
    delete withoutText.text;
    expect(() => parseTranscript(withoutText)).toThrowError(/text/);
  });

  it("rejects an utterance without word timestamps", () => {
    const broken = {
      ...fixture,
      utterances: [{ ...fixture.utterances[0], words: undefined }],
    };
    expect(() => parseTranscript(broken)).toThrowError(/words/);
  });

  it("accepts words without optional speaker and confidence fields", () => {
    const utterance = fixture.utterances[0];
    const word = utterance.words[0];
    const bareWord: Record<string, unknown> = { ...word };
    delete bareWord.speaker;
    delete bareWord.confidence;
    const payload = {
      ...fixture,
      utterances: [{ ...utterance, words: [bareWord] }],
    };
    expect(parseTranscript(payload).utterances[0].words[0].text).toBe(word.text);
  });
});
