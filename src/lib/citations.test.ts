import { describe, expect, it } from "vitest";
import { extractSources, stripStreamingSourcesTail } from "./citations";

describe("extractSources", () => {
  it("splits a trailing SOURCES line from the spoken answer", () => {
    expect(extractSources("The smoke is from Canada.\nSOURCES: 1,3")).toEqual({
      answer: "The smoke is from Canada.",
      sources: [1, 3],
      hasSourcesLine: true,
    });
  });

  it("accepts a SOURCES tail on the same line as the answer", () => {
    expect(extractSources("The smoke is from Canada. SOURCES: 1,2")).toEqual({
      answer: "The smoke is from Canada.",
      sources: [1, 2],
      hasSourcesLine: true,
    });
  });

  it("tolerates spaces and brackets in the list", () => {
    expect(extractSources("Answer here.\nSOURCES: [2, 4]").sources).toEqual([2, 4]);
    expect(extractSources("Answer here.\n\nSOURCES:1").sources).toEqual([1]);
  });

  it("distinguishes an explicit empty SOURCES line from a missing one", () => {
    const explicit = extractSources("Hey, good to meet you too!\nSOURCES:");
    expect(explicit).toEqual({
      answer: "Hey, good to meet you too!",
      sources: [],
      hasSourcesLine: true,
    });
    const missing = extractSources("Just an answer with no citations.");
    expect(missing).toEqual({
      answer: "Just an answer with no citations.",
      sources: [],
      hasSourcesLine: false,
    });
  });

  it("only strips a SOURCES line at the end, not mid-answer", () => {
    const text = "I checked the SOURCES: they were clear.\nMore answer.";
    expect(extractSources(text)).toEqual({ answer: text, sources: [], hasSourcesLine: false });
  });

  it("deduplicates and drops non-positive indexes", () => {
    expect(extractSources("A.\nSOURCES: 2, 2, 0, -1, 3").sources).toEqual([2, 3]);
  });

  it("handles an empty answer", () => {
    expect(extractSources("")).toEqual({ answer: "", sources: [], hasSourcesLine: false });
  });
});

describe("stripStreamingSourcesTail", () => {
  it("leaves text without a SOURCES tail unchanged", () => {
    expect(stripStreamingSourcesTail("The smoke is from Canada.")).toBe(
      "The smoke is from Canada.",
    );
  });

  it("strips a complete trailing SOURCES line", () => {
    expect(stripStreamingSourcesTail("The smoke is from Canada.\nSOURCES: 1,3")).toBe(
      "The smoke is from Canada.",
    );
  });

  it("hides a SOURCES line still being streamed, at any prefix", () => {
    for (const tail of ["S", "SOU", "SOURCES", "SOURCES:", "SOURCES: 1,", "SOURCES: [2, "]) {
      expect(stripStreamingSourcesTail(`Answer here.\n${tail}`)).toBe("Answer here.");
    }
  });

  it("keeps ordinary words that start with S", () => {
    expect(stripStreamingSourcesTail("It was built by SpaceX")).toBe("It was built by SpaceX");
    expect(stripStreamingSourcesTail("Ask Steve")).toBe("Ask Steve");
  });

  it("keeps a SOURCES mention that is not at the end", () => {
    const text = "I checked the SOURCES: they were clear.\nMore answer.";
    expect(stripStreamingSourcesTail(text)).toBe(text);
  });

  it("handles empty text", () => {
    expect(stripStreamingSourcesTail("")).toBe("");
  });
});
