import { describe, expect, it } from "vitest";
import { isLikelyEcho } from "./echoGuard";

const recentSpeech =
  "I read that Aristotle was Alexander the Great's tutor. Glad you think so. " +
  "Every once in a while, a revolutionary product comes along that changes everything.";

describe("isLikelyEcho", () => {
  it("flags a transcript that repeats the persona's own words", () => {
    expect(isLikelyEcho("Glad you think so.", recentSpeech)).toBe(true);
    expect(isLikelyEcho("glad you think so", recentSpeech)).toBe(true);
  });

  it("flags a mid-sentence fragment of played speech", () => {
    expect(isLikelyEcho("a revolutionary product comes along", recentSpeech)).toBe(true);
  });

  it("lets a genuine new question through", () => {
    expect(isLikelyEcho("What did you announce in 2007?", recentSpeech)).toBe(false);
    expect(isLikelyEcho("Tell me more about Aristotle.", recentSpeech)).toBe(false);
  });

  it("never blocks short conversational replies", () => {
    // one- or two-word turns ("Cool.", "Thank you.") are too common to treat as echo
    expect(isLikelyEcho("So?", "so what do you mean by that")).toBe(false);
    expect(isLikelyEcho("Thank you.", "thank you for being here today")).toBe(false);
  });

  it("survives punctuation and casing differences", () => {
    expect(isLikelyEcho("EVERY once in a while — a revolutionary product!", recentSpeech)).toBe(
      true,
    );
  });

  it("handles empty inputs", () => {
    expect(isLikelyEcho("", recentSpeech)).toBe(false);
    expect(isLikelyEcho("anything at all", "")).toBe(false);
  });
});
