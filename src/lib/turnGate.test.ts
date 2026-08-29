import { describe, expect, it } from "vitest";
import { mergeHeldTurn, shouldHoldTurn } from "./turnGate";

describe("shouldHoldTurn", () => {
  it("holds a lone persona first name", () => {
    expect(shouldHoldTurn("Steve.", "Steve Jobs")).toBe(true);
  });
  it("holds a greeting plus full name even past two words", () => {
    expect(shouldHoldTurn("Hey, Steve Jobs.", "Steve Jobs")).toBe(true);
  });
  it("holds any one- or two-word fragment", () => {
    expect(shouldHoldTurn("Okay so", "Steve Jobs")).toBe(true);
  });
  it("does not hold a real question that starts with the name", () => {
    expect(shouldHoldTurn("Steve, what do you think about design?", "Steve Jobs")).toBe(false);
  });
  it("does not hold a normal three-word request", () => {
    expect(shouldHoldTurn("Tell me more.", "Steve Jobs")).toBe(false);
  });
  it("never holds blank text", () => {
    expect(shouldHoldTurn("   ", "Steve Jobs")).toBe(false);
  });
});

describe("mergeHeldTurn", () => {
  it("joins the address and the question with a comma", () => {
    expect(mergeHeldTurn("Steve.", "What made the iPhone happen?")).toBe(
      "Steve, What made the iPhone happen?",
    );
  });
  it("returns the follow-up alone when the held text is blank", () => {
    expect(mergeHeldTurn("  ", "why?")).toBe("why?");
  });
  it("returns the held text alone when the follow-up is blank", () => {
    expect(mergeHeldTurn("Steve", "")).toBe("Steve");
  });
});
