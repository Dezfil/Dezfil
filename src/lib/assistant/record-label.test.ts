import { describe, expect, it } from "vitest";
import { composeLabel, recordedSubject } from "./record-label";

describe("the record's words", () => {
  it("names the subject by its display name from the response, else the arguments, else its identity", () => {
    const display = { verb: "Updated the layer {subject}", subject: { resource: "layers" as const, argument: "id", name: ["name"] } };
    const named = recordedSubject(display, { id: "l1", name: "Parks" }, { id: "l1", name: "Parks (renamed)" });
    expect(named).toEqual({ resource: "layers", id: "l1", name: "Parks (renamed)" });
    expect(composeLabel(display, { id: "l1" }, named)).toBe("Updated the layer Parks (renamed)");
    const fromArgs = recordedSubject(display, { id: "l1", name: "Parks" });
    expect(composeLabel(display, {}, fromArgs)).toBe("Updated the layer Parks");
    const identity = recordedSubject(display, { id: "l1" }, null);
    expect(identity).toEqual({ resource: "layers", id: "l1" });
    expect(composeLabel(display, {}, identity)).toBe("Updated the layer l1");
  });
  it("takes a created subject's identity from the response and fills argument placeholders", () => {
    const created = { verb: "Created the map {subject}", subject: { resource: "maps" as const, result: "id", name: ["name"] } };
    expect(recordedSubject(created, { name: "Evening" }, { id: "m9", name: "Evening" })).toEqual({ resource: "maps", id: "m9", name: "Evening" });
    const fill = { verb: "Computed a {arg.method} fill by {arg.attribute} on the layer {subject}", subject: { resource: "layers" as const, argument: "id" } };
    expect(composeLabel(fill, { id: "l1", method: "quantile", attribute: "area_m2" }, recordedSubject(fill, { id: "l1" }))).toBe("Computed a quantile fill by area_m2 on the layer l1");
    // A placeholder nothing fills leaves the sentence readable, never a hole.
    expect(composeLabel(fill, { id: "l1" }, recordedSubject(fill, { id: "l1" }))).toBe("Computed a fill by on the layer l1");
  });
  it("declares no subject for an operation without one", () => {
    expect(recordedSubject({ verb: "Ran a query" }, { sql: "SELECT 1" }, [])).toBeUndefined();
    expect(composeLabel({ verb: "Ran a query" }, { sql: "SELECT 1" })).toBe("Ran a query");
  });
});
