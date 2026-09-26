import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { ApiError } from "@/lib/api/errors";
import { compileOperation } from "./compile";
import { OPERATIONS, findOperation } from "./catalog";
import { MEASURES } from "./metric-verbs";

/**
 * What the catalog promises about a measurement.
 *
 * The point is that an agent can tell **which parameter is a
 * ground distance** without knowing the verb in advance. A catalog that
 * described a measurement as a bare number would leave every caller to guess
 * the unit, and the guess that looks right — the geometry's own units — is the
 * five-hundred-degree buffer this spec exists to prevent.
 */

describe("the catalog says which numbers are ground metres", () => {
  it("marks the buffer's distance as a measurement, in a form read without knowing the verb", () => {
    const buffer = findOperation("buffer");
    const distance = buffer.parameters.find((p) => p.name === "distance")!;
    expect(distance.unit).toBe("metres");
    expect(distance.description).toMatch(/on the ground/i);
    // And says what it is *not*, because both wrong readings are plausible.
    expect(distance.description).toMatch(/not degrees/i);
    expect(distance.description).toMatch(/not metres on a map projection/i);
  });

  it("declares each verb's inputs and the geometry they need", () => {
    for (const id of ["buffer", "measure_columns"]) {
      const operation = findOperation(id);
      expect(operation.inputs).toHaveLength(1);
      expect(operation.inputs[0].accepts).toEqual(["point", "line", "polygon"]);
      expect(operation.inputs[0].required).toBe(true);
    }
  });

  it("declares `measures` as a list, which is what the run path expects", () => {
    // A scalar `enum` here would tell an agent to send one value where a list
    // is required — the catalog describing a shape the implementation refuses.
    const measures = findOperation("measure_columns").parameters.find(
      (p) => p.name === "measures",
    )!;
    expect(measures.type).toBe("enum_list");
    expect(measures.options).toEqual([...MEASURES]);
  });

  it("says what each measure produces, including which are not measurements", () => {
    const measures = findOperation("measure_columns").parameters.find(
      (p) => p.name === "measures",
    )!;
    expect(measures.description).toMatch(/area_m2, square metres of ground/i);
    expect(measures.description).toMatch(/length_m, metres of ground/i);
    // A polygon's length is its perimeter — stated, because the alternative
    // reading returns zero and nobody notices.
    expect(measures.description).toMatch(/for a polygon is its perimeter/i);
    // And x/y are coordinates, said in as many words.
    expect(measures.description).toMatch(/coordinates rather than measurements/i);
  });

  it("keeps every verb's declared output geometry honest", () => {
    // A buffer always makes polygons; measure columns keeps what it was given.
    expect(findOperation("buffer").outputGeometry).toEqual({
      kind: "fixed",
      geometry: "polygon",
    });
    expect(findOperation("measure_columns").outputGeometry).toEqual({
      kind: "from_input",
      input: "input",
    });
  });
});

describe("the published description carries the contract", () => {
  const runDescription = () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { description?: string }>>;
    };
    return doc.paths["/api/operations/run"].post.description ?? "";
  };

  it("states that measurements are ground metres, and what happens when they cannot be", () => {
    const description = runDescription();
    expect(description).toMatch(/ground metres/i);
    expect(description).toMatch(/never degrees/i);
    expect(description).toContain("measurement_crs_unavailable");
    // The area's different answer is documented beside the distance's refusal,
    // because a caller who read only one would think the whole request fails.
    expect(description).toMatch(/area\*\* over the same data succeeds/i);
    expect(description).toMatch(/assumed rather than declared/i);
  });

  it("reaches an agent through the one run tool, not a tool per verb", () => {
    // These verbs are catalog data behind the existing endpoint. A tool per
    // verb is the shape this phase deliberately did not take.
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { "x-tool"?: string | false }>>;
    };
    expect(doc.paths["/api/operations/run"].post["x-tool"]).toBe("run_operation");
    for (const id of ["buffer", "measure_columns"]) {
      expect(OPERATIONS.some((o) => o.id === id)).toBe(true);
    }
  });
});

describe("the error catalogue's delta", () => {
  /** What was documented before this spec, written out rather than derived. */
  const BEFORE_THIS_SPEC = [
    "operation_timeout",
    "operation_queue_full",
    "operation_interrupted",
    "operation_superseded",
  ];
  /** G2's ruling: exactly one new code. */
  const APPROVED_AT_THIS_GATE = ["measurement_crs_unavailable"];

  it("gains exactly the code the gate approved", () => {
    const measurementish = Object.keys(ERROR_CATALOGUE).filter((c) =>
      /^measurement_|^operation_/.test(c),
    );
    const added = measurementish.filter((c) => !BEFORE_THIS_SPEC.includes(c)).sort();
    expect(added).toEqual([...APPROVED_AT_THIS_GATE].sort());
    for (const code of APPROVED_AT_THIS_GATE) {
      const documented = ERROR_CATALOGUE[code as keyof typeof ERROR_CATALOGUE];
      expect(documented.length).toBeGreaterThan(20);
      // The documented sentence carries what the refusal itself carries.
      expect(documented).toMatch(/split it by region/i);
    }
  });
});

describe("a generated client can discover the contract", () => {
  const schemas = () => {
    const doc = buildOpenApiDocument() as unknown as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    return doc.components.schemas;
  };

  it("declares the parameter shapes the catalog actually returns", () => {
    // Prose on the endpoint is not the machine-readable surface. A client
    // generated from this document must be able to read a verb's inputs, its
    // output geometry, and which of its numbers is a ground measurement.
    const catalog = JSON.parse(
      JSON.stringify(schemas().OperationCatalog),
    ) as {
      properties: {
        operations: {
          items: {
            properties: {
              inputs?: unknown;
              outputGeometry?: unknown;
              parameters: {
                items: {
                  properties: {
                    type: { enum: string[] };
                    unit?: { enum: string[] };
                    options?: unknown;
                    ofInput?: unknown;
                  };
                };
              };
            };
          };
        };
      };
    };
    const operation = catalog.properties.operations.items.properties;
    expect(operation.inputs).toBeDefined();
    expect(operation.outputGeometry).toBeDefined();

    const parameter = operation.parameters.items.properties;
    // The list type, whose absence was the round's catch: a client told `enum`
    // sends one value where the run path requires a list.
    expect(parameter.type.enum).toContain("enum_list");
    expect(parameter.type.enum).toContain("number_list");
    // And the unit marker, which is what makes "which number is metres"
    // answerable without knowing the verb. Minutes joined at (K7).
    expect(parameter.unit?.enum).toEqual(["metres", "minutes"]);
    expect(parameter.options).toBeDefined();
    expect(parameter.ofInput).toBeDefined();
  });

  it("carries the metric fields on the answers that report a run", () => {
    const dryRun = schemas().OperationDryRun as never as {
      properties: Record<string, unknown>;
    };
    expect(dryRun.properties.warnings).toBeDefined();
    expect(dryRun.properties.measurement).toBeDefined();

    const run = schemas().OperationRun as never as {
      properties: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
    };
    expect(run.properties.warnings).toBeDefined();
    // third subject kind, which a generated client would otherwise reject
    // as an unknown value.
    expect(run.properties.subject.properties?.kind.enum).toEqual([
      "run",
      "client",
      "step",
    ]);

    expect(schemas().OperationMeasurement).toBeDefined();
  });
});

describe("a distance is a number, not something that looks like one", () => {
  /** The catalog says `number`; coercion would accept three other shapes. */
  const NOT_NUMBERS: [string, unknown][] = [
    ["a boolean", true],
    ["a numeric string", "500"],
    ["a one-element array", [500]],
    ["null", null],
    ["zero", 0],
    ["a negative", -500],
  ];

  for (const [label, distance] of NOT_NUMBERS) {
    it(`refuses ${label}`, async () => {
      // `Number(true)` is 1, so a boolean would have become a one-metre
      // buffer; `Number(["500"])` is 500. Both are malformed requests, and a
      // measurement built from one is a number nobody asked for.
      await expect(
        compileOperation("buffer", { input: "anything", distance, name: "x" }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  }
});
