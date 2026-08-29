import { describe, expect, it } from "vitest";
import { getPersona } from "./personas";

describe("Andrej Karpathy persona", () => {
  it("is available at the indexed persona id with grounded style quotes", () => {
    const persona = getPersona("andrej-karpathy");

    expect(persona).toMatchObject({
      id: "andrej-karpathy",
      name: "Andrej Karpathy",
    });
    expect(persona.description.length).toBeGreaterThan(20);
    expect(persona.quotes).toHaveLength(5);
    expect(persona.quotes.every((quote) => quote.length > 20)).toBe(true);
  });

  it("does not claim a cloned voice without affirmative consent", () => {
    expect(getPersona("andrej-karpathy").voiceId).toBeUndefined();
  });
});
