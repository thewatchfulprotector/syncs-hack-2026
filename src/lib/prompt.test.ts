import { describe, expect, it } from "vitest";
import { buildPersonaPrompt, formatTimestamp } from "./prompt";
import type { RetrievedChunk } from "./retrieval";
import type { Persona } from "./personas";

const persona: Persona = {
  id: "test-person",
  name: "Testy McTestface",
  description: "a meteorologist who explains weather plainly",
  quotes: ["Well, there's a couple of things.", "It is. It is.", "That's a good question."],
};

function chunk(id: string, text: string, startMs?: number): RetrievedChunk {
  return {
    id,
    score: 0.5,
    metadata: {
      persona_id: "test-person",
      source_file: "interview.mp3",
      media_type: "audio",
      text,
      ...(startMs !== undefined ? { start_ms: startMs, end_ms: startMs + 1000 } : {}),
    },
  };
}

describe("formatTimestamp", () => {
  it("formats milliseconds as m:ss", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(28014)).toBe("0:28");
    expect(formatTimestamp(149347)).toBe("2:29");
    expect(formatTimestamp(3723000)).toBe("1:02:03");
  });
});

describe("buildPersonaPrompt", () => {
  const chunks = [chunk("c0", "The smoke came from Canada.", 28014), chunk("c1", "Kids are most at risk.")];
  const messages = buildPersonaPrompt(persona, chunks, "Who is most at risk?");

  it("returns a system message followed by the user question", () => {
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "Who is most at risk?" });
  });

  it("identifies the persona and includes every style quote verbatim", () => {
    const system = messages[0].content;
    expect(system).toContain("Testy McTestface");
    expect(system).toContain(persona.description);
    for (const quote of persona.quotes) expect(system).toContain(quote);
  });

  it("numbers each excerpt from 1 with source and timestamp", () => {
    const system = messages[0].content;
    expect(system).toContain("[1]");
    expect(system).toContain("[2]");
    expect(system).toContain("The smoke came from Canada.");
    expect(system).toContain("Kids are most at risk.");
    expect(system).toContain("interview.mp3");
    expect(system).toContain("0:28");
  });

  it("instructs the model to emit a machine-readable SOURCES line", () => {
    expect(messages[0].content).toContain("SOURCES:");
  });

  it("caps style quotes at five", () => {
    const many = { ...persona, quotes: Array.from({ length: 9 }, (_, i) => `quote-${i}`) };
    const system = buildPersonaPrompt(many, chunks, "q")[0].content;
    expect(system).toContain("quote-4");
    expect(system).not.toContain("quote-5");
  });
});
