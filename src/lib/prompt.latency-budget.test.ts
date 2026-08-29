import { describe, expect, it } from "vitest";
import type { Persona } from "./personas";
import { buildPersonaPrompt, type ChatMessage } from "./prompt";

const HISTORY_MESSAGE_LIMIT = 6;
const HISTORY_CHARACTER_BUDGET = 6_000;

const persona: Persona = {
  id: "test-person",
  name: "Test Person",
  description: "someone who answers plainly",
  blurb: "Someone who answers plainly.",
  quotes: [],
};

describe("voice prompt latency budget", () => {
  it("asks for a short, direct first sentence so speech can start early", () => {
    const system = buildPersonaPrompt(persona, [], "What happened?")[0].content;

    expect(system).toMatch(/\b(?:first|opening)\s+sentence\b|\bopen with\b/i);
    expect(system).toMatch(/\bshort\b/i);
    expect(system).toMatch(/\bdirect\b/i);
  });

  it("defensively caps history by both message count and aggregate characters", () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index}:` + String(index).repeat(2_000),
    }));

    const promptHistory = buildPersonaPrompt(persona, [], "latest question", history).slice(
      1,
      -1,
    );
    const totalCharacters = promptHistory.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    expect(promptHistory.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
    expect(totalCharacters).toBeLessThanOrEqual(HISTORY_CHARACTER_BUDGET);
    expect(promptHistory.at(-1)?.content).toContain("turn-9:");
  });
});
