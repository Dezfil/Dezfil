import { describe, it, expect } from "vitest";
import {
  OPERATIONS,
  findOperation,
  type OperationDef,
} from "@/lib/operations/catalog";
import {
  defaultOutputName,
  initialParameters,
  isComplete,
  whatIsMissing,
  nameProblem,
  prefillNote,
  registeredName,
  suggestedOperations,
  tablesNamedIn,
  helpLine,
  outOfBounds,
  numberListProblem,
  parameterRelevant,
  activeParameters,
} from "./operation-form";
import type { TableListing } from "../../api";

/**
 * The Result section's rules.
 *
 * Each of these is a promise the user reads before pressing Run, and each can
 * be broken in a way a rendering assertion would not notice.
 */

const buffer = OPERATIONS.find((o) => o.id === "buffer")!;
const sqlStep = OPERATIONS.find((o) => o.id === "sql_step")!;
const join = OPERATIONS.find((o) => o.id === "spatial_join")!;

function table(over: Partial<TableListing> = {}): TableListing {
  return {
    id: "t1",
    name: "stations",
    sourceFilename: "stations.geojson",
    format: "geoparquet",
    file: "tables/stations.parquet",
    geometryColumn: "geom",
    geometryType: "POINT",
    crsAssumed: false,
    rowCount: 12,
    createdAt: "2026-08-13T10:00:00.000Z",
    source: "upload",
    sourceParams: null,
    importedAt: null,
    sizeBytes: 1024,
    ...over,
  } as TableListing;
}

describe("the name the result will actually carry", () => {
  it("is the registry's, not the one typed", () => {
    // The materializer sanitizes into a SQL identifier. A form that promised
    // "Bus Stops" would deliver `bus_stops` — the defect G2 exists to prevent.
    expect(registeredName("Bus Stops")).toBe("bus_stops");
    expect(registeredName("  rings  ")).toBe("rings");
  });

  it("refuses a taken name before the run, naming the conflict", () => {
    const taken = (n: string) => n === "rings";
    expect(nameProblem("rings", taken)).toMatch(/already exists/);
    // Named, not merely refused: the message says which name collided.
    expect(nameProblem("rings", taken)).toContain("rings");
    expect(nameProblem("halos", taken)).toBeNull();
  });

  it("catches a collision that only appears after sanitizing", () => {
    // "Rings!" registers as `rings`, so a check against the raw text would
    // pass here and the run would be refused at admission instead — which is
    // exactly the wrong side of the boundary.
    expect(nameProblem("Rings!", (n) => n === "rings")).toMatch(/already exists/);
  });

  it("refuses an empty name rather than inventing one", () => {
    expect(nameProblem("   ", () => false)).toMatch(/needs a name/);
    expect(nameProblem("!!!", () => false)).toMatch(/no letters or digits/);
  });

  it("derives a default from what it reads and what it does", () => {
    expect(defaultOutputName(buffer, "stations", () => false)).toBe(
      "stations_buffer",
    );
    // A default that was already taken would be a form that opens broken.
    expect(
      defaultOutputName(buffer, "stations", (n) => n === "stations_buffer"),
    ).toBe("stations_buffer_2");
  });
});

describe("what the form starts with, and when it is runnable", () => {
  it("takes every declared default and invents nothing else", () => {
    const params = initialParameters(join);
    expect(params.predicate).toBe("intersects");
    expect(params.carry).toEqual([]);
    // The output name belongs to the Result section, not the grid.
    expect(params.name).toBeUndefined();
  });

  it("is incomplete until every required input and parameter is filled", () => {
    expect(isComplete(buffer, {})).toBe(false);
    expect(isComplete(buffer, { input: "stations" })).toBe(false);
    expect(isComplete(buffer, { input: "stations", distance: 500 })).toBe(true);
    // An empty list is not a filled list.
    const ready = {
      left: "a",
      right: "b",
      predicate: "intersects",
      carry: [{ aggregate: "count" }],
    };
    expect(isComplete(join, { ...ready, carry: [] })).toBe(false);
    expect(isComplete(join, ready)).toBe(true);
    // And a required parameter that only has a catalog default still has to
    // be present: the form fills it, a caller that dropped it has not.
    expect(isComplete(join, { ...ready, predicate: "" })).toBe(false);
  });
});

describe("what the door can pre-fill", () => {
  const tables = [table(), table({ id: "t2", name: "blocks" })];

  it("finds the table a plain layer reads", () => {
    expect(
      tablesNamedIn("SELECT * FROM stations", tables).map((t) => t.name),
    ).toEqual(["stations"]);
  });

  it("does not match a name inside a longer word", () => {
    expect(tablesNamedIn("SELECT * FROM stations_buffer", tables)).toHaveLength(
      0,
    );
  });

  it("says plainly where the pre-fill differs from what the layer draws", () => {
    // A filtered layer's table holds rows the layer does not show. Saying so
    // is the difference between a pre-fill and a silent scope change.
    const note = prefillNote({ sql: "…", filters: [{}, {}] }, [tables[0]]);
    expect(note).toMatch(/2 filters/);
    expect(note).toMatch(/SQL step/);
    expect(prefillNote({ sql: "…", filters: [] }, [tables[0]])).toBeNull();
    expect(prefillNote({ sql: "…" }, [])).toMatch(/nothing to pre-fill/);
    expect(prefillNote({ sql: "…" }, tables)).toMatch(/more than one table/);
  });
});

describe("what an empty recipe suggests", () => {
  it("offers four verbs that fit the input's geometry", () => {
    const suggested = suggestedOperations(OPERATIONS, "point");
    expect(suggested.length).toBeLessThanOrEqual(4);
    for (const operation of suggested) {
      expect(
        operation.accepts.includes("any") || operation.accepts.includes("point"),
        operation.id,
      ).toBe(true);
    }
  });

  it("does not suggest a verb the input's geometry cannot take", () => {
    // A suggestion list is an opinion; a wrong one costs more than a neutral
    // catalog, so a verb that would be refused is not among them.
    const polygonOnly: OperationDef = {
      ...OPERATIONS[0],
      id: "polygons_only",
      accepts: ["polygon"],
    };
    expect(
      suggestedOperations([polygonOnly, ...OPERATIONS], "point").map((o) => o.id),
    ).not.toContain("polygons_only");
  });

  it("suggests everything when nothing is known about the input", () => {
    expect(suggestedOperations(OPERATIONS, null).length).toBe(
      Math.min(4, OPERATIONS.length),
    );
  });
});

describe("the catalog the form renders from", () => {
  it("describes every verb it offers, so nothing is hard-coded here", () => {
    for (const operation of OPERATIONS) {
      expect(operation.label).not.toBe("");
      expect(operation.group).not.toBe("");
      // Every verb declares where its output's geometry comes from, which is
      // what G3 reads. A verb that did not would silently default to offered.
      expect(operation.outputGeometry.kind).toMatch(
        /^(probed|none|from_input|fixed)$/,
      );
    }
    expect(sqlStep.inputs).toHaveLength(0);
  });
});

describe("what the form is still waiting for", () => {
  /**
   * **A disabled Run button that says nothing was the defect.** The verb's
   * other fields look complete, the button is inert, and the control still
   * needed carries no mark — a user's only route was to guess. Asserting the
   * *names* rather than a count is what makes this useful: a reason that said
   * "something is missing" would pass a length check and help nobody.
   */
  const hotspot = findOperation("hotspot");

  it("names the conditionally required parameter, and only when its condition holds", () => {
    // Counting cells needs no field, so nothing is waiting.
    expect(
      whatIsMissing(hotspot, { input: "sightings", resolution: 8 }),
    ).toEqual([]);
    // Summing one does — and that is the case was reported against.
    expect(
      whatIsMissing(hotspot, {
        input: "sightings",
        resolution: 8,
        value: "sum",
      }),
    ).toEqual(["a field"]);
  });

  it("names an input by the label the form puts on it", () => {
    const missing = whatIsMissing(hotspot, { resolution: 8 });
    expect(missing).toContain(hotspot.inputs[0].label.toLowerCase());
  });

  it("names a required parameter in the words the form labels it with", () => {
    // Underscores are what the identifier has; the form shows spaces, and the
    // reason has to name the control the user is looking at.
    const buffer = findOperation("buffer");
    expect(whatIsMissing(buffer, { input: "stations" })).toEqual(["a distance"]);
  });

  it("returns phrases a sentence can join without adding words", () => {
    /**
     * **The joining is dumb on purpose, so the phrases have to be complete.**
     * A caller prepending "a " to every entry produced *"Choose a features to
     * buffer and a distance to run this."* — because an input's label is
     * already a plural phrase — and *"Choose a a column for each carry"*, where
     * the phrase brought its own article. Found at the cross-model review.
     *
     * So: no entry begins with a doubled article, and every entry reads as a
     * grammatical continuation of "Choose …".
     */
    for (const operation of OPERATIONS) {
      for (const entry of whatIsMissing(operation, {})) {
        expect(entry, `${operation.id}: "${entry}"`).not.toMatch(/^a a /);
        expect(entry, `${operation.id}: "${entry}"`).not.toMatch(/^an? +$/);
        expect(entry.trim(), `${operation.id}`).toBe(entry);
        expect(entry.length, `${operation.id}`).toBeGreaterThan(0);
      }
    }
    // The two shapes, spelled out: an input keeps its own plural phrase, a
    // parameter takes an article.
    const buffer = findOperation("buffer");
    expect(whatIsMissing(buffer, {})).toEqual([
      buffer.inputs[0].label.toLowerCase(),
      "a distance",
    ]);
  });

  it("agrees with isComplete, which is now derived from it", () => {
    const buffer = findOperation("buffer");
    for (const params of [
      {},
      { input: "stations" },
      { input: "stations", distance: 500 },
    ]) {
      expect(isComplete(buffer, params)).toBe(
        whatIsMissing(buffer, params).length === 0,
      );
    }
  });
});

describe("the help line", () => {
  it("keeps the first sentence and strips markdown", () => {
    expect(
      helpLine(
        "How far the ring stands from each feature, in **metres on the " +
          "ground**. Not degrees, and not metres on a map projection.",
      ),
    ).toBe("How far the ring stands from each feature, in metres on the ground.");
  });

  it("returns a sentence-less text whole, stripped", () => {
    expect(helpLine("Just a `fragment` with **marks**")).toBe(
      "Just a fragment with marks",
    );
  });
});

describe("the catalog's bounds, enforced before the wire", () => {
  /**
   * **The form used to knowingly send what the catalog refuses.** With `min`
   * and `max` served, a typed H3 resolution of 16 still reached the dry run
   * and came back as a server refusal — the range check lived only in native
   * form validation this UI never invokes. Now the sentence is the form's
   * own, and the gate holds without a request.
   */
  const hotspot = findOperation("hotspot");

  it("refuses a number outside the served range, in a sentence naming it", () => {
    expect(
      outOfBounds(hotspot, { input: "sightings", resolution: 16 }),
    ).toEqual(["A resolution is 0 to 15."]);
    expect(
      outOfBounds(hotspot, { input: "sightings", resolution: -1 }),
    ).toEqual(["A resolution is 0 to 15."]);
  });

  it("says nothing about an in-range, absent, or under-ceiling value", () => {
    expect(outOfBounds(hotspot, { input: "sightings", resolution: 15 })).toEqual([]);
    expect(outOfBounds(hotspot, { input: "sightings" })).toEqual([]);
    // Below buffer's served ceiling — a big distance stays open.
    expect(
      outOfBounds(findOperation("buffer"), { input: "a", distance: 9_999_999 }),
    ).toEqual([]);
  });

  it("a ceiling standing alone refuses past it, in the same voice", () => {
    // The metre parameters serve only `max` — their floor is exclusive zero,
    // which a served `min` cannot express — and the gate still holds.
    const buffer = findOperation("buffer");
    expect(outOfBounds(buffer, { input: "a", distance: 1e12 })).toEqual([
      "A distance is at most 20,003,932 metres.",
    ]);
    expect(
      outOfBounds(buffer, { input: "a", distance: 20_003_932 }),
    ).toEqual([]);
    expect(
      outOfBounds(findOperation("simplify"), { input: "a", tolerance: 1e12 }),
    ).toEqual(["A tolerance is at most 20,003,932 metres."]);
    // Hidden stays silent, however absurd: the ceiling is part of the
    // question only when the field is.
    expect(
      outOfBounds(findOperation("filter_by_location"), {
        input: "a",
        mask: "b",
        relation: "within",
        distance: 1e12,
      }),
    ).toEqual([]);
  });
});

describe("what is part of the question at all", () => {
  /**
   * **The field round found a live distance slider on an "intersects"
   * question**, and its stray 0 rode the dry run into a refusal about a
   * field the question did not contain. `relevantWhen` is the catalog's
   * answer; these hold its three subtleties.
   */
  const filterByLocation = findOperation("filter_by_location");
  const filterRows = findOperation("filter_rows");
  const hotspot = findOperation("hotspot");
  const parameterOf = (op: OperationDef, name: string) => {
    const found = op.parameters.find((p) => p.name === name);
    if (!found) throw new Error(`${op.id} has no parameter ${name}`);
    return found;
  };

  it("a distance is no part of an intersects question, and every part of a within-distance one", () => {
    const distance = parameterOf(filterByLocation, "distance");
    expect(parameterRelevant(distance, { relation: "intersects" })).toBe(false);
    expect(parameterRelevant(distance, { relation: "within" })).toBe(false);
    expect(parameterRelevant(distance, { relation: "within_distance" })).toBe(true);
  });

  it("used is wider than required: the comparison value applies to five comparisons, not one", () => {
    // Required only for "equals" — but greater_than reads it too, so a
    // reveal driven by requiredWhen would hide a field five comparisons use.
    const value = parameterOf(filterRows, "value");
    expect(parameterRelevant(value, { comparison: "greater_than" })).toBe(true);
    expect(parameterRelevant(value, { comparison: "is_null" })).toBe(false);
    const field = parameterOf(hotspot, "field");
    expect(parameterRelevant(field, { value: "count" })).toBe(false);
    expect(parameterRelevant(field, { value: "sum" })).toBe(true);
  });

  it("an inapplicable value never reaches a request, and comes back when it applies again", () => {
    const params = { input: "a", mask: "b", relation: "within", distance: 0 };
    expect(activeParameters(filterByLocation, params)).not.toHaveProperty("distance");
    // The state keeps the typed value; only the request loses it.
    expect(params.distance).toBe(0);
    expect(
      activeParameters(filterByLocation, { ...params, relation: "within_distance" }),
    ).toHaveProperty("distance", 0);
  });

  it("an inapplicable required parameter is never named missing", () => {
    expect(
      whatIsMissing(filterByLocation, {
        input: "a",
        mask: "b",
        relation: "within",
      }),
    ).toEqual([]);
  });
});

describe("the ground-metres floor", () => {
  it("refuses zero and negative metres in the form's own sentence, before the wire", () => {
    const buffer = findOperation("buffer");
    expect(outOfBounds(buffer, { input: "a", distance: 0 })).toEqual([
      "A distance is more than 0 metres.",
    ]);
    expect(outOfBounds(buffer, { input: "a", distance: -50 })).toEqual([
      "A distance is more than 0 metres.",
    ]);
    // A half metre is legitimate — the floor is exclusive zero, not 1.
    expect(outOfBounds(buffer, { input: "a", distance: 0.5 })).toEqual([]);
  });

  it("says nothing about a hidden distance, whatever it holds", () => {
    expect(
      outOfBounds(findOperation("filter_by_location"), {
        input: "a",
        mask: "b",
        relation: "within",
        distance: 0,
      }),
    ).toEqual([]);
  });
});

describe("the number list's field refusals ('s logic)", () => {
  /**
   * Every rule is the served declaration, not form opinion: fractions and
   * the floor in one sentence, duplicates in another, and a valid set says
   * nothing — the dry run's admission is the gate's business.
   */
  const isochrone = findOperation("isochrone");
  const base = { input: "a", travel_mode: "driving" };

  it("refuses fractions, the floor, and duplicates in the form's own sentences", () => {
    expect(outOfBounds(isochrone, { ...base, bands: [7.5] })).toEqual([
      "Each bands value is a whole number of at least 1.",
    ]);
    expect(outOfBounds(isochrone, { ...base, bands: [0] })).toEqual([
      "Each bands value is a whole number of at least 1.",
    ]);
    expect(outOfBounds(isochrone, { ...base, bands: [10, 5, 10] })).toEqual([
      "Each value is asked once. 10 appears twice.",
    ]);
  });

  it("says nothing about a valid set, and an empty list is missing rather than out of bounds", () => {
    expect(outOfBounds(isochrone, { ...base, bands: [5, 10, 15, 60] })).toEqual([]);
    expect(outOfBounds(isochrone, { ...base, bands: [] })).toEqual([]);
    // The footer speaks grammatically for a plural list.
    expect(whatIsMissing(isochrone, { ...base, bands: [] })).toContain("bands");
  });
});

describe("the served cardinality", () => {
  it("refuses a fifth band and honours a declared minimum, generically", () => {
    const isochrone = findOperation("isochrone");
    const bands = isochrone.parameters.find((p) => p.name === "bands")!;
    expect(numberListProblem(bands, [1, 2, 3, 4, 5])).toBe(
      "At most 4 bands values.",
    );
    const invented = { ...bands, minItems: 2 };
    expect(numberListProblem(invented, [5])).toBe("At least 2 bands values.");
    expect(numberListProblem(bands, [1, 2, 3, 4])).toBeNull();
  });
});
