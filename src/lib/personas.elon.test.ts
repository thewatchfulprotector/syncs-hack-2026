import { describe, expect, it } from "vitest";
import { getPersona } from "./personas";

describe("Elon Musk persona", () => {
  it("is available at the indexed persona id with grounded style quotes", () => {
    const persona = getPersona("elon-musk");

    expect(persona).toMatchObject({ id: "elon-musk", name: "Elon Musk" });
    expect(persona.description.length).toBeGreaterThan(20);
    expect(persona.quotes).toHaveLength(5);
    expect(persona.quotes.every((quote) => quote.length > 20)).toBe(true);
  });

  it("does not claim a cloned voice before one is authorized and configured", () => {
    expect(getPersona("elon-musk").voiceId).toBeUndefined();
  });
});
