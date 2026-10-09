import { describe, expect, it } from "vitest";
import { secretForms } from "./address-secrets";

/**
 * The forms a key is looked for in, written out here byte for byte, so a
 * form dropped from the secrecy battery's search fails this file rather than
 * quietly narrowing it.
 */

describe("the forms a secret is looked for in", () => {
  it("are the secret as written, percent-encoded, base64, base64url, hex and UTF-16", () => {
    expect(secretForms("SEEDED-KEY-0003-PASS?")).toEqual([
      "SEEDED-KEY-0003-PASS?",
      "SEEDED-KEY-0003-PASS%3F",
      "U0VFREVELUtFWS0wMDAzLVBBU1M/",
      "U0VFREVELUtFWS0wMDAzLVBBU1M_",
      "5345454445442d4b45592d303030332d504153533f",
      [..."SEEDED-KEY-0003-PASS?"].map(character => `${character}\u0000`).join(""),
    ]);
  });

  it("name each form once where two coincide", () => {
    expect(secretForms("SEEDED-KEY-0003-QUERY")).toEqual([
      "SEEDED-KEY-0003-QUERY",
      "U0VFREVELUtFWS0wMDAzLVFVRVJZ",
      "5345454445442d4b45592d303030332d5155455259",
      [..."SEEDED-KEY-0003-QUERY"].map(character => `${character}\u0000`).join(""),
    ]);
  });
});
