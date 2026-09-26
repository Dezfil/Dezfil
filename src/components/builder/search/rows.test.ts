import { describe, it, expect } from "vitest";
import { buildRows, CLOSE_ZOOM } from "./rows";

describe("search rows (the per-class semantics)", () => {
  it("maps every class to its camera and marker", () => {
    const { groups, flat, attribution } = buildRows({
      layers: [{ layerId: "l1", name: "Stations", viz: "points" }],
      values: [
        {
          layerId: "l1",
          layerName: "Stations",
          field: "name",
          value: "Alexanderplatz",
          point: [13.41, 52.52],
        },
        {
          layerId: "l2",
          layerName: "Districts",
          field: "name",
          value: "Mitte",
          anchor: [13.4, 52.5],
          bounds: [13, 52, 14, 53],
        },
      ],
      coordinates: [{ reading: "latlon", lat: 52.5, lng: 13.4 }],
      places: {
        state: "ok",
        attribution: "© contributors",
        results: [
          { name: "Berlin", context: "Deutschland", lng: 13.4, lat: 52.5, bounds: [13, 52, 14, 53] },
          { name: "Spot", context: null, lng: 1, lat: 2 },
        ],
      },
    });

    expect(groups.map((g) => g.key)).toEqual([
      "layer",
      "value",
      "coordinate",
      "place",
    ]);
    expect(attribution).toBe("© contributors");
    expect(flat).toHaveLength(6);

    const [layer, pointValue, areaValue, coord, boxedPlace, pointPlace] = flat;
    // A layer row fits the layer, no marker (its shipped default); its
    // context line is the viz type, as the prototype shows.
    expect(layer.action).toEqual({ type: "fit-layer", layerId: "l1" });
    expect(layer.context).toBe("Points");
    // A point value match flies to the feature, marker on it.
    expect(pointValue.action).toEqual({
      type: "fly",
      lng: 13.41,
      lat: 52.52,
      zoom: CLOSE_ZOOM,
      marker: { lng: 13.41, lat: 52.52, label: "Alexanderplatz" },
    });
    expect(pointValue.context).toBe("Stations");
    // A polygon/line value match fits its bounds, marker at the anchor.
    expect(areaValue.action).toEqual({
      type: "fit",
      bounds: [13, 52, 14, 53],
      marker: { lng: 13.4, lat: 52.5, label: "Mitte" },
    });
    // A coordinate row flies at the documented close zoom, labelled by
    // its reading.
    expect(coord.label).toBe("52.5, 13.4");
    expect(coord.context).toBe("as latitude, longitude");
    expect(coord.action.type).toBe("fly");
    // A place with a bounding box fits it; the marker sits at the point.
    expect(boxedPlace.action).toEqual({
      type: "fit",
      bounds: [13, 52, 14, 53],
      marker: { lng: 13.4, lat: 52.5, label: "Berlin" },
    });
    // A place without one flies to its point.
    expect(pointPlace.action.type).toBe("fly");
  });

  it("labels the transposed reading in its own order", () => {
    const { flat } = buildRows({
      layers: [],
      values: [],
      coordinates: [{ reading: "lonlat", lat: 13.4, lng: 52.5 }],
      places: null,
    });
    expect(flat[0].label).toBe("52.5, 13.4");
    expect(flat[0].context).toBe("as longitude, latitude");
  });

  it("holds empty groups out and gives rows unique active-descendant ids", () => {
    const { groups, flat } = buildRows({
      layers: [],
      values: [],
      coordinates: [
        { reading: "latlon", lat: 1, lng: 2 },
        { reading: "lonlat", lat: 2, lng: 1 },
      ],
      places: { state: "unconfigured" },
    });
    expect(groups).toHaveLength(1);
    expect(new Set(flat.map((r) => r.id)).size).toBe(flat.length);
  });
});
