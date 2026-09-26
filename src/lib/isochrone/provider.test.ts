import { describe, it, expect } from "vitest";
import { readIsochroneBody } from "./provider";

/**
 * The provider's answer, read against the checks (the literal-fixture
 * halves).
 *
 * Every fixture states its coordinates in the test, because the class this
 * guards against — a plausible polygon in the wrong place — is invisible to
 * any assertion that trusts the code to build its own expectation.
 */

const ORIGIN = { lon: 13.4, lat: 52.5 };

/** A ring around the origin, stated literally and closed. */
const SQUARE = [
  [13.39, 52.49],
  [13.41, 52.49],
  [13.41, 52.51],
  [13.39, 52.51],
  [13.39, 52.49],
];

const snapped = (positions: number[][]) => ({
  type: "Feature",
  properties: { type: "snapped" },
  geometry: { type: "MultiPoint", coordinates: positions },
});

const inputPoint = () => ({
  type: "Feature",
  properties: { type: "input" },
  geometry: { type: "Point", coordinates: [ORIGIN.lon, ORIGIN.lat] },
});

const contour = (minutes: number, coordinates: unknown, type = "Polygon") => ({
  type: "Feature",
  properties: { contour: minutes },
  geometry: { type, coordinates },
});

const body = (features: unknown[]) =>
  JSON.stringify({ type: "FeatureCollection", features });

const NEAR = [[13.4005, 52.5005]];

describe("the area is the provider's, unchanged", () => {
  it("passes a stated polygon through exactly", () => {
    const answer = readIsochroneBody(
      body([contour(5, [SQUARE]), snapped(NEAR), inputPoint()]),
      ORIGIN,
      [5],
    );
    expect(answer.bands).toEqual([
      {
        minutes: 5,
        status: "answered",
        wkt: "POLYGON((13.39 52.49, 13.41 52.49, 13.41 52.51, 13.39 52.51, 13.39 52.49))",
      },
    ]);
    expect(answer.snappedLon).toBeCloseTo(13.4005, 6);
    expect(answer.snappedLat).toBeCloseTo(52.5005, 6);
  });

  it("a band answered with two features arrives as one multipolygon of two parts", () => {
    const east = [
      [13.5, 52.49],
      [13.52, 52.49],
      [13.52, 52.51],
      [13.5, 52.49],
    ];
    const answer = readIsochroneBody(
      body([contour(5, [SQUARE]), contour(5, [east]), snapped(NEAR)]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("answered");
    expect(answer.bands[0].wkt).toMatch(/^MULTIPOLYGON/);
    expect(answer.bands[0].wkt!.match(/\(\(/g)).toHaveLength(2);
  });

  it("keeps a hole's ring in the published geometry (the rule's unit half)", () => {
    const hole = [
      [13.395, 52.495],
      [13.405, 52.495],
      [13.405, 52.505],
      [13.395, 52.495],
    ];
    const answer = readIsochroneBody(
      // The candidate sits inside the outer ring and outside the hole.
      body([contour(5, [SQUARE, hole]), snapped([[13.408, 52.508]])]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("answered");
    expect(answer.bands[0].wkt).toContain(
      "(13.395 52.495, 13.405 52.495, 13.405 52.505, 13.395 52.495)",
    );
  });
});

describe("a transposed answer is refused (K8)", () => {
  it("coordinates swapped but inside legal ranges fail the containment, not the range check", () => {
    // lat/lon transposed: (52.49, 13.39)… — every value legal as both a
    // longitude and a latitude, so range checking alone cannot catch it.
    const transposed = SQUARE.map(([lon, lat]) => [lat, lon]);
    const answer = readIsochroneBody(
      body([contour(5, [transposed]), snapped(NEAR)]),
      ORIGIN,
      [5],
    );
    expect(answer.bands).toEqual([
      { minutes: 5, status: "unreadable_answer", wkt: null },
    ]);
    expect(answer.snappedLon).toBeNull();
  });

  it("a candidate farther than the snap distance vouches for nothing", () => {
    // Inside the polygon, but ~7 km from the origin as asked.
    const answer = readIsochroneBody(
      body([
        contour(5, [
          [
            [13.3, 52.4],
            [13.6, 52.4],
            [13.6, 52.6],
            [13.3, 52.6],
            [13.3, 52.4],
          ],
        ]),
        snapped([[13.5, 52.55]]),
      ]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("unreadable_answer");
  });

  it("contours with no readable location feature fail closed", () => {
    const answer = readIsochroneBody(body([contour(5, [SQUARE])]), ORIGIN, [5]);
    expect(answer.bands[0].status).toBe("unreadable_answer");
  });
});

describe("what else the answer must survive", () => {
  it("refuses an open ring rather than silently closing it", () => {
    const open = SQUARE.slice(0, -1); // last point no longer equals the first
    const answer = readIsochroneBody(
      body([contour(5, [open]), snapped(NEAR)]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("unreadable_answer");
  });

  it("refuses a line contour: polygons were mandatory in the request", () => {
    const answer = readIsochroneBody(
      body([contour(5, SQUARE, "LineString"), snapped(NEAR)]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("unreadable_answer");
  });

  it("refuses a response over the vertex budget, whole", () => {
    const huge = [
      ...Array.from({ length: 100_001 }, (_, i) => [
        13.39 + (i % 100) * 1e-6,
        52.49 + Math.floor(i / 100) * 1e-6,
      ]),
    ];
    huge.push(huge[0]);
    const answer = readIsochroneBody(
      body([contour(5, [huge]), snapped(NEAR)]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("unreadable_answer");
  });

  it("reads unparseable text as unreadable for every band", () => {
    const answer = readIsochroneBody("{not json", ORIGIN, [5, 10]);
    expect(answer.bands.map((b) => b.status)).toEqual([
      "unreadable_answer",
      "unreadable_answer",
    ]);
  });
});

describe("bands are matched by contour, never by position", () => {
  it("a clamped contour is never published under a band the user asked for", () => {
    // The provider clamped 90 down to 60 and answered a contour of 60 —
    // which was not requested, so it is ignored and 90 is unreachable.
    const answer = readIsochroneBody(
      body([contour(60, [SQUARE]), contour(5, [SQUARE]), snapped(NEAR)]),
      ORIGIN,
      [5, 90],
    );
    expect(answer.bands).toEqual([
      expect.objectContaining({ minutes: 5, status: "answered" }),
      { minutes: 90, status: "unreachable", wkt: null },
    ]);
  });

  it("no requested contour at all is unreachable, not unreadable — the provider answered", () => {
    const answer = readIsochroneBody(
      body([snapped(NEAR), inputPoint()]),
      ORIGIN,
      [5, 10],
    );
    expect(answer.bands.map((b) => b.status)).toEqual([
      "unreachable",
      "unreachable",
    ]);
    expect(answer.source).toBe("wire");
  });
});

describe("the round's catches, pinned", () => {
  it("one valid band may not vouch for a transposed sibling — the whole origin is unreadable", () => {
    const transposed = SQUARE.map(([lon, lat]) => [lat, lon]);
    const answer = readIsochroneBody(
      body([contour(5, [SQUARE]), contour(10, [transposed]), snapped(NEAR)]),
      ORIGIN,
      [5, 10],
    );
    expect(answer.bands.map((b) => b.status)).toEqual([
      "unreadable_answer",
      "unreadable_answer",
    ]);
  });

  it("a JSON null, a scalar, and a null feature are unreadable, never a crash", () => {
    expect(readIsochroneBody("null", ORIGIN, [5]).bands[0].status).toBe(
      "unreadable_answer",
    );
    expect(readIsochroneBody("42", ORIGIN, [5]).bands[0].status).toBe(
      "unreadable_answer",
    );
    const withNull = JSON.stringify({
      type: "FeatureCollection",
      features: [null, contour(5, [SQUARE]), snapped(NEAR)],
    });
    expect(readIsochroneBody(withNull, ORIGIN, [5]).bands[0].status).toBe(
      "answered",
    );
  });

  it("an over-budget unrequested contour still breaks the response's budget", () => {
    const huge = [
      ...Array.from({ length: 100_001 }, (_, i) => [
        13.39 + (i % 100) * 1e-6,
        52.49 + Math.floor(i / 100) * 1e-6,
      ]),
    ];
    huge.push(huge[0]);
    const answer = readIsochroneBody(
      // The 60-minute contour was never asked for; its vertices were sent
      // all the same.
      body([contour(60, [huge]), contour(5, [SQUARE]), snapped(NEAR)]),
      ORIGIN,
      [5],
    );
    expect(answer.bands[0].status).toBe("unreadable_answer");
  });
});
