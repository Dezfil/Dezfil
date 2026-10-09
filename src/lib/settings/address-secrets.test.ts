import { describe, expect, it } from "vitest";
import { repeatsAddressSecret, secretForms, secretParts } from "./address-secrets";

/**
 * The parts of a service address that may carry a key, and the forms a key
 * is looked for in. The forms are written out here byte for byte, so a form
 * dropped from the check (and from the secrecy battery's search, which uses
 * the same list) fails this file rather than quietly narrowing both.
 */

const ADDRESS = "http://seed-user:SEEDED%2DKEY%2D0003%2DPASS@127.0.0.1:9/osm-SEEDED-KEY-0003-PATH/api/interpreter?key=SEEDED-KEY-0003-QUERY&v=1";

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

describe("the parts of an address that may carry a key", () => {
  it("are the user, the password, the Basic pair, the path, the query, each value and each long segment, written and decoded", () => {
    expect(new Set(secretParts(ADDRESS))).toEqual(new Set([
      "seed-user",
      "SEEDED%2DKEY%2D0003%2DPASS",
      "SEEDED-KEY-0003-PASS",
      "seed-user:SEEDED-KEY-0003-PASS",
      "/osm-SEEDED-KEY-0003-PATH/api/interpreter",
      "osm-SEEDED-KEY-0003-PATH",
      "key=SEEDED-KEY-0003-QUERY&v=1",
      "SEEDED-KEY-0003-QUERY",
    ]));
  });

  it("leave out what is too short to be a key, and an address with nothing past its host", () => {
    expect(secretParts("https://overpass.example/api/x?v=1")).toEqual(["/api/x"]);
    expect(secretParts("https://overpass.example/")).toEqual([]);
  });

  it("are the whole text when it is not an address", () => {
    expect(secretParts("SEEDED-KEY-0003-TEXT")).toEqual(["SEEDED-KEY-0003-TEXT"]);
  });
});

describe("whether text repeats a part of the address", () => {
  const credential = `Basic ${Buffer.from("seed-user:SEEDED-KEY-0003-PASS").toString("base64")}`;

  it.each([
    ["the path as written", "no route for /osm-SEEDED-KEY-0003-PATH/api/interpreter"],
    ["a query value", "key SEEDED-KEY-0003-QUERY refused"],
    ["the decoded password", "bad password SEEDED-KEY-0003-PASS"],
    ["the password as written", "bad password SEEDED%2DKEY%2D0003%2DPASS"],
    ["the Basic credential", `refused ${credential}`],
    ["the path in hex", `trace ${Buffer.from("/osm-SEEDED-KEY-0003-PATH/api/interpreter?key=SEEDED-KEY-0003-QUERY").toString("hex")}`],
    ["a value in base64url", `id ${Buffer.from("SEEDED-KEY-0003-QUERY").toString("base64url")}`],
    ["a segment in UTF-16", `${Buffer.from("osm-SEEDED-KEY-0003-PATH", "utf16le").toString("latin1")}`],
  ])("finds %s", (_what, text) => {
    expect(repeatsAddressSecret(text, ADDRESS)).toBe(true);
  });

  it("finds nothing in words that repeat none of it", () => {
    expect(repeatsAddressSecret("line 1: parse error: unknown type \"nod\"", ADDRESS)).toBe(false);
    expect(repeatsAddressSecret("runtime error: Query timed out in \"query\" at line 1 after 26 seconds.", ADDRESS)).toBe(false);
  });
});
