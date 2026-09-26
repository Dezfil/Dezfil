import { describe, it, expect } from "vitest";
import { matches } from "./match";

describe("the shared substring matcher", () => {
  it("matches case-insensitive substrings", () => {
    expect(matches("Berlin Stations", "sta")).toBe(true);
    expect(matches("Berlin Stations", "BERLIN")).toBe(true);
    expect(matches("Berlin Stations", "bremen")).toBe(false);
  });

  it("folds Unicode case, not just ASCII", () => {
    expect(matches("STRASSE", "strasse")).toBe(true);
    expect(matches("Çankaya", "çank")).toBe(true);
    expect(matches("МОСКВА", "москва")).toBe(true);
  });

  it("folds beyond simple lowercase: ß and the Turkish İ", () => {
    expect(matches("Hauptstraße", "STRASSE")).toBe(true);
    expect(matches("STRASSE", "straße")).toBe(true);
    expect(matches("İstanbul", "istanbul")).toBe(true);
    expect(matches("istanbul", "İstanbul")).toBe(true);
  });

  it("treats pattern characters as literal text", () => {
    expect(matches("100% organic", "100%")).toBe(true);
    expect(matches("a_b", "a_b")).toBe(true);
    expect(matches("abc", "a%c")).toBe(false);
    expect(matches("abc", "a_c")).toBe(false);
  });

  it("an empty query matches nothing", () => {
    expect(matches("anything", "")).toBe(false);
  });
});
