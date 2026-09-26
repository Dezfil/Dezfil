import { describe, it, expect } from "vitest";
import { NORMALIZATION_VERSION, normalizeAddress } from "./normalize";

/**
 * The rule that turns an address into a cache identity.
 *
 * Two properties are worth pinning: that differences no geocoder cares about
 * collapse to one key, and that differences it *would* care about do not — a
 * normalization that stripped punctuation or expanded abbreviations would send
 * the provider something the user did not write.
 */

describe("normalizeAddress", () => {
  it("collapses only what no geocoder should care about", () => {
    const canonical = normalizeAddress("Alexanderplatz 1, Berlin");
    for (const spelling of [
      "  Alexanderplatz 1, Berlin  ",
      "Alexanderplatz  1,   Berlin",
      "ALEXANDERPLATZ 1, BERLIN",
      "alexanderplatz 1, berlin",
      "Alexanderplatz\t1,\nBerlin",
    ]) {
      expect(normalizeAddress(spelling), spelling).toBe(canonical);
    }
  });

  it("folds case rather than lowercasing it", () => {
    // **The difference shows up in ordinary addresses.** `toLowerCase` maps
    // `Straße` to `straße` and `STRASSE` to `strasse` — two keys and two
    // requests for one address a geocoder answers identically, since ß and ss
    // are alternate spellings of the same street. Folding collapses them.
    // Found at the cross-model review.
    const key = normalizeAddress("Hauptstraße 1, Berlin");
    for (const spelling of [
      "Hauptstrasse 1, Berlin",
      "HAUPTSTRASSE 1, BERLIN",
      "HAUPTSTRAßE 1, BERLIN",
    ]) {
      expect(normalizeAddress(spelling), spelling).toBe(key);
    }
  });

  it("keeps differences a geocoder would answer differently for", () => {
    const distinct = [
      "Hauptstrasse 1, Berlin",
      // An abbreviation is not expanded — that is the provider's job, and
      // guessing here would send it something the user did not write.
      "Hauptstr. 1, Berlin",
      "Hauptstrasse 2, Berlin",
      "Hauptstrasse 1, Bremen",
    ].map((a) => normalizeAddress(a));
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("says there is nothing to ask about, rather than asking about nothing", () => {
    // An empty address is its own row outcome, not a query that finds no
    // match — so this answers null rather than the empty string.
    for (const empty of ["", "   ", "\t\n", null, undefined, 42, {}]) {
      expect(normalizeAddress(empty), JSON.stringify(empty)).toBeNull();
    }
  });

  it("normalizes the several Unicode spellings of one character", () => {
    // Composed vs decomposed: the same address typed on two keyboards.
    expect(normalizeAddress("Café 1")).toBe(normalizeAddress("Café 1"));
  });

  it("carries a version, because the rule is part of an identity", () => {
    expect(Number.isInteger(NORMALIZATION_VERSION)).toBe(true);
    expect(NORMALIZATION_VERSION).toBeGreaterThan(0);
  });
});
