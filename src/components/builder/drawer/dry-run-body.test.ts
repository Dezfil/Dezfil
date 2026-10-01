import { describe, expect, it } from "vitest";
import { dryRunBody } from "./use-dry-run";

/** A tool's check over a layer previews the layer's SQL in its map's home,
 * as the run's capture carries it from there; anything else checks as the
 * caller's console reads it. */
describe("the dry run's request", () => {
  it("says where a layer's SQL was written", () => {
    expect(JSON.parse(dryRunBody({ operation: "buffer", parameters: { sql: "SELECT * FROM roads" }, writtenIn: { kind: "map", id: "m1" } })))
      .toEqual({ operation: "buffer", parameters: { sql: "SELECT * FROM roads" }, dryRun: true, writtenIn: { kind: "map", id: "m1" } });
    expect(JSON.parse(dryRunBody({ operation: "buffer", parameters: { input: "roads" } })))
      .toEqual({ operation: "buffer", parameters: { input: "roads" }, dryRun: true });
  });
});
