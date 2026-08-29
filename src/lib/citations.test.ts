import { describe, expect, it } from "vitest";
import { extractSources } from "./citations";

describe("extractSources", () => {
  it("splits a trailing SOURCES line from the spoken answer", () => {
    expect(extractSources("The smoke is from Canada.\nSOURCES: 1,3")).toEqual({
      answer: "The smoke is from Canada.",
      sources: [1, 3],
    });
  });

  it("accepts a SOURCES tail on the same line as the answer", () => {
    expect(extractSources("The smoke is from Canada. SOURCES: 1,2")).toEqual({
      answer: "The smoke is from Canada.",
      sources: [1, 2],
    });
  });

  it("tolerates spaces and brackets in the list", () => {
    expect(extractSources("Answer here.\nSOURCES: [2, 4]").sources).toEqual([2, 4]);
    expect(extractSources("Answer here.\n\nSOURCES:1").sources).toEqual([1]);
  });

  it("returns the whole text and no sources when the line is absent", () => {
    expect(extractSources("Just an answer with no citations.")).toEqual({
      answer: "Just an answer with no citations.",
      sources: [],
    });
  });

  it("only strips a SOURCES line at the end, not mid-answer", () => {
    const text = "I checked the SOURCES: they were clear.\nMore answer.";
    expect(extractSources(text)).toEqual({ answer: text, sources: [] });
  });

  it("deduplicates and drops non-positive indexes", () => {
    expect(extractSources("A.\nSOURCES: 2, 2, 0, -1, 3").sources).toEqual([2, 3]);
  });

  it("handles an empty answer", () => {
    expect(extractSources("")).toEqual({ answer: "", sources: [] });
  });
});
