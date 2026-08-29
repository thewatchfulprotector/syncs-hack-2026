import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./sentences";

function feedAll(splitter: SentenceSplitter, tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) out.push(...splitter.push(token));
  return out;
}

describe("SentenceSplitter", () => {
  it("emits a sentence once its boundary and following space arrive", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello world")).toEqual([]);
    expect(s.push(". Next")).toEqual(["Hello world."]);
    expect(s.flush()).toBe("Next");
  });

  it("reassembles sentences from tokens split mid-word", () => {
    const s = new SentenceSplitter();
    const out = feedAll(s, ["Hel", "lo wor", "ld. It wor", "ks! And more"]);
    expect(out).toEqual(["Hello world.", "It works!"]);
    expect(s.flush()).toBe("And more");
  });

  it("emits multiple sentences arriving in one token", () => {
    const s = new SentenceSplitter();
    expect(s.push("One. Two? Three! Four")).toEqual(["One.", "Two?", "Three!"]);
  });

  it("keeps closing quotes and brackets with their sentence", () => {
    const s = new SentenceSplitter();
    const out = feedAll(s, ['He said "stop." Then he left. ']);
    expect(out).toEqual(['He said "stop."', "Then he left."]);
  });

  it("does not split decimal numbers", () => {
    const s = new SentenceSplitter();
    const out = feedAll(s, ["Levels hit 2.5 micrograms today. Wow "]);
    expect(out).toEqual(["Levels hit 2.5 micrograms today."]);
  });

  it("does not split common abbreviations", () => {
    const s = new SentenceSplitter();
    const out = feedAll(s, ["Dr. Smith and Mr. Jones arrived. Later "]);
    expect(out).toEqual(["Dr. Smith and Mr. Jones arrived."]);
  });

  it("treats an ellipsis followed by space as a boundary", () => {
    const s = new SentenceSplitter();
    expect(s.push("Well... maybe not. ")).toEqual(["Well...", "maybe not."]);
  });

  it("handles newlines as sentence terminators for the trailing fragment", () => {
    const s = new SentenceSplitter();
    expect(s.push("First line.\nSecond thing ")).toEqual(["First line."]);
    expect(s.flush()).toBe("Second thing");
  });

  it("flush returns null when nothing is pending", () => {
    const s = new SentenceSplitter();
    s.push("Done. ");
    expect(s.flush()).toBeNull();
    expect(new SentenceSplitter().flush()).toBeNull();
  });

  it("trims whitespace from emitted sentences", () => {
    const s = new SentenceSplitter();
    expect(s.push("  Spaced out.   Next one. ")).toEqual(["Spaced out.", "Next one."]);
  });

  it("survives a realistic streamed answer", () => {
    const s = new SentenceSplitter();
    const text =
      "Well, the smoke is coming from Canada. We've got weather systems channeling it south. " +
      "It's the youngest who are most at risk, kids whose bodies are still developing. " +
      "SOURCES: 1,2";
    const tokens = text.match(/.{1,7}/g)!;
    const out = feedAll(s, tokens);
    const rest = s.flush();
    expect(out).toEqual([
      "Well, the smoke is coming from Canada.",
      "We've got weather systems channeling it south.",
      "It's the youngest who are most at risk, kids whose bodies are still developing.",
    ]);
    expect(rest).toBe("SOURCES: 1,2");
  });
});
