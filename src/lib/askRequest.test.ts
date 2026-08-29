import { describe, expect, it } from "vitest";
import { parseAskRequest } from "./askRequest";
import { MAX_HISTORY_MESSAGES } from "./prompt";

describe("parseAskRequest", () => {
  it("accepts a minimal valid body and defaults history to empty", () => {
    expect(parseAskRequest({ personaId: "steve", question: "Why?" })).toEqual({
      personaId: "steve",
      question: "Why?",
      history: [],
    });
  });

  it("keeps the question verbatim, without trimming", () => {
    const parsed = parseAskRequest({ personaId: "steve", question: "  Why?  " });
    expect(parsed?.question).toBe("  Why?  ");
  });

  it("filters junk history entries and keeps valid turns in order", () => {
    const parsed = parseAskRequest({
      personaId: "steve",
      question: "Why?",
      history: [
        { role: "user", content: "first" },
        { role: "system", content: "not a conversation turn" },
        { role: "assistant", content: 42 },
        "junk",
        null,
        { role: "assistant", content: "second" },
      ],
    });
    expect(parsed?.history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("caps an over-long history to the newest turns", () => {
    const history = Array.from({ length: MAX_HISTORY_MESSAGES + 4 }, (_, i) => ({
      role: "user",
      content: `turn ${i}`,
    }));
    const parsed = parseAskRequest({ personaId: "steve", question: "Why?", history });
    expect(parsed?.history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(parsed?.history.at(-1)?.content).toBe(`turn ${MAX_HISTORY_MESSAGES + 3}`);
  });

  it("tolerates a non-array history", () => {
    const parsed = parseAskRequest({
      personaId: "steve",
      question: "Why?",
      history: "corrupted",
    });
    expect(parsed?.history).toEqual([]);
  });

  it("returns null when personaId is missing or not a string", () => {
    expect(parseAskRequest({ question: "Why?" })).toBeNull();
    expect(parseAskRequest({ personaId: 7, question: "Why?" })).toBeNull();
  });

  it("returns null when the question is missing, blank, or not a string", () => {
    expect(parseAskRequest({ personaId: "steve" })).toBeNull();
    expect(parseAskRequest({ personaId: "steve", question: "   " })).toBeNull();
    expect(parseAskRequest({ personaId: "steve", question: ["Why?"] })).toBeNull();
  });

  it("returns null for a non-object body, as from unparseable JSON", () => {
    expect(parseAskRequest(null)).toBeNull();
    expect(parseAskRequest(undefined)).toBeNull();
    expect(parseAskRequest("personaId=steve")).toBeNull();
  });
});
