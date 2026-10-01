import { describe, expect, it } from "vitest";
import { landingRequest, tableSubject } from "./AddToMapDialog";
import { previewRequest } from "./builder/add-layer/catalog-state";

/**
 * The requests behind "Add to a map" and the add-layer workbench's preview.
 * A dataset is named as its reader types it, so another person's
 * same-named dataset is never the one that lands, and every landing says it
 * was written as the console reads it, which is what lets the server carry
 * it into the picked map's home. The workbench previews in the map's home,
 * the context its saved layer is read in.
 */
describe("the add-to-map landing", () => {
  it("names another person's dataset by its qualified name and takes the dataset's own name for the layer", () => {
    expect(tableSubject("ada.roads")).toEqual({ sql: "SELECT * FROM ada.roads", name: "roads", label: "roads" });
    expect(tableSubject("roads")).toEqual({ sql: "SELECT * FROM roads", name: "roads", label: "roads" });
    expect(tableSubject(null)).toBeNull();
  });

  it("says the SQL was written in the console", () => {
    expect(landingRequest(tableSubject("ada.roads")!, "  ")).toEqual({
      name: "roads", sql: "SELECT * FROM ada.roads", writtenIn: { kind: "console" },
    });
    expect(landingRequest({ sql: "SELECT 1", name: "q", label: "q" }, "Mine").name).toBe("Mine");
  });
});

describe("the workbench preview", () => {
  it("runs in the map's home when it knows the map, else in the console", () => {
    expect(previewRequest("SELECT * FROM roads", "map-1")).toEqual({ sql: "SELECT * FROM roads", writtenIn: { kind: "map", id: "map-1" } });
    expect(previewRequest("SELECT * FROM roads")).toEqual({ sql: "SELECT * FROM roads" });
  });
});
