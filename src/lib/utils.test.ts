import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins class strings with single spaces", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values so conditional classes read cleanly", () => {
    expect(cn("base", false, undefined, null, "", "active")).toBe("base active");
    expect(cn(false && "never", "kept")).toBe("kept");
  });

  it("returns an empty string for no truthy inputs", () => {
    expect(cn()).toBe("");
    expect(cn(false, undefined)).toBe("");
  });
});
