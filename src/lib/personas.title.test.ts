import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_ID, personas, personaTitle } from "./personas";

describe("personaTitle", () => {
  it("title-cases a kebab-case persona id", () => {
    expect(personaTitle("steve-jobs")).toBe("Steve Jobs");
    expect(personaTitle("steve-jobs")).toBe("Steve Jobs");
    expect(personaTitle("elon-musk")).toBe("Elon Musk");
  });

  it("leaves a single word capitalised", () => {
    expect(personaTitle("aristotle")).toBe("Aristotle");
  });
});

describe("DEFAULT_PERSONA_ID", () => {
  it("names a persona that exists in the registry", () => {
    expect(personas[DEFAULT_PERSONA_ID]).toBeDefined();
  });
});
