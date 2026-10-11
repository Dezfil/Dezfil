import { describe, expect, it } from "vitest";
import type { Layer } from "@/lib/metadata/maps";
import type { CategoricalFill, LayerStyle, RgbaColor } from "@/lib/style/style";
import type { OpenedTemplate } from "@/lib/templates/opened";
import { comesWith, dataRows, stepTitle, styleWords, templatePage } from "./template-view-model";

/**
 * How a template's page words what the template holds: each dataset's row
 * with its source, licence and credit and what was measured of it; a
 * layer's style in one line; a step's title; and a workflow example's
 * documents as the canvas reads a workflow's, every step the template's
 * own result and none ever run, its arrangement at the recipe's revision.
 */

const ink: RgbaColor = { r: 20, g: 40, b: 60, a: 1 };
const base: LayerStyle = {
  fill: { type: "constant", color: ink }, fillOpacity: 1, stroke: ink, strokeOpacity: 1,
  strokeWidth: 1, pointRadius: 4, opacity: 1,
};
const layer = (style: Partial<LayerStyle>, viz: Layer["viz"] = { type: "points" } as Layer["viz"]): Pick<Layer, "style" | "viz"> =>
  ({ style: { ...base, ...style }, viz });

const SOURCES = [
  { name: "Transit office", licence: "CC-BY-4.0", credit: "© Transit office" },
  { name: "Boundary office", licence: "ODbL-1.0", credit: "© Boundary office" },
];
const HOW = {
  question: "Which stations are busy?",
  datasets: [
    { dataset: "stations", source: "Transit office", made: "Station points as published." },
    { dataset: "districts", source: "Nobody listed", made: "District outlines." },
  ],
  styling: ["Points."],
};
const dataset = (name: string, rowCount: number, geometryType: string | null) => ({
  id: `template.busy-stations.3.dataset.${name}`, name, rowCount, geometryColumn: geometryType ? "geom" : null, geometryType,
});
const OPENED: OpenedTemplate = {
  id: "busy-stations", version: 3, revision: "a".repeat(32), mapId: "template.busy-stations.3.map",
  createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-06T10:00:00.000Z",
  datasets: [dataset("stations", 6, "POINT"), dataset("districts", 2, "POLYGON")],
  workflow: {
    name: "Busy stations",
    steps: [
      { id: "step-busy", operation: "sql_step", parameters: { sql: "SELECT 1", name: "busy_stations" },
        output: { ...dataset("busy_stations", 4, "POINT"), id: "template.busy-stations.3.result.step-busy" }, reads: ["stations"] },
      { id: "step-rings", operation: "buffer", parameters: { input: "busy_stations", distance: 250, name: "station_rings" },
        output: { ...dataset("station_rings", 4, "POLYGON"), id: "template.busy-stations.3.result.step-rings" }, reads: ["busy_stations"] },
    ],
    layout: { steps: { "step-busy": { x: 1, y: 2 } }, sources: {}, notes: [], updatedAt: "2026-01-06T10:00:00.000Z" },
  },
};

describe("the Data section's rows", () => {
  it("gives each dataset its line, its source by name and what the install measured", () => {
    expect(dataRows({ howMade: HOW, sources: SOURCES }, OPENED)).toEqual([
      { dataset: "stations", made: "Station points as published.", source: SOURCES[0], rowCount: 6, geometryType: "POINT", geometryColumn: "geom" },
      { dataset: "districts", made: "District outlines.", source: null, rowCount: 2, geometryType: "POLYGON", geometryColumn: "geom" },
    ]);
  });

  it("measures nothing before the version is installed", () => {
    expect(dataRows({ howMade: HOW, sources: SOURCES }, null).map((row) => [row.rowCount, row.geometryType]))
      .toEqual([[null, null], [null, null]]);
  });
});

describe("a layer's style in words", () => {
  it("says one colour, and an opacity below full", () => {
    expect(styleWords(layer({}))).toBe("One colour");
    expect(styleWords(layer({ opacity: 0.8 }))).toBe("One colour, 80% opacity");
  });

  it("says what the colour follows, by kind and method", () => {
    const categorical: CategoricalFill = { type: "categorical", attribute: "line", palette: "p", map: [{ value: "a", color: ink }, { value: "b", color: ink }], other: ink };
    expect(styleWords(layer({ fill: categorical }))).toBe("Coloured by line, 2 categories");
    const ramp = (method?: "quantile" | "equal" | "natural" | "custom") =>
      layer({ fill: { type: "quantile", attribute: "riders", palette: "p", method, breaks: [1, 2, 3, 4], colors: [ink, ink, ink, ink, ink] } });
    expect(styleWords(ramp())).toBe("Coloured by riders in 5 classes, quantile breaks");
    expect(styleWords(ramp("equal"))).toBe("Coloured by riders in 5 classes, equal intervals");
    expect(styleWords(ramp("natural"))).toBe("Coloured by riders in 5 classes, natural breaks");
    expect(styleWords(ramp("custom"))).toBe("Coloured by riders in 5 classes, breaks set by hand");
    expect(styleWords(layer({ fill: { type: "continuous", attribute: "riders", palette: "p", domain: [0, 10], stops: [ink, ink] } })))
      .toBe("Coloured by riders on a continuous ramp");
  });

  it("names every channel the data drives, then the labels", () => {
    const scale = (attribute: string) => ({ attribute, domain: [0, 1] as [number, number], range: [1, 2] as [number, number] });
    const label = { attribute: "name", size: 12, color: ink, haloWidth: 0, haloColor: ink };
    expect(styleWords(layer({
      strokeBy: { type: "categorical", attribute: "kind", palette: "p", map: [], other: ink },
      pointRadiusBy: scale("riders"), strokeWidthBy: scale("width"), heightBy: scale("floors"), label,
    }))).toBe("One colour, outline by kind, size by riders, line width by width, height by floors, labelled by name");
  });

  it("words cells as the map draws them: their own fill, labelled with their value", () => {
    const cellFill = { type: "continuous", attribute: "count", palette: "p", domain: [0, 9], stops: [ink, ink] } as const;
    const cells = layer(
      { pointRadiusBy: { attribute: "riders", domain: [0, 1], range: [1, 2] }, label: { size: 12, color: ink, haloWidth: 0, haloColor: ink } },
      { type: "hexbin", cellKm: 1, aggregate: { fn: "count" }, fill: cellFill } as unknown as Layer["viz"],
    );
    expect(styleWords(cells)).toBe("Coloured by count on a continuous ramp, labelled with each cell's value");
  });
});

describe("a step's title", () => {
  it("numbers the step and names its operation, by the catalog once read", () => {
    expect(stepTitle(0, "buffer", null)).toBe("1 · buffer");
    expect(stepTitle(1, "buffer", (op) => (op === "buffer" ? "Buffer" : op))).toBe("2 · Buffer");
  });
});

describe("a workflow example's documents for the canvas", () => {
  it("is nothing for a map template", () => {
    expect(templatePage({ id: "harbour-stations", version: 1 }, { ...OPENED, workflow: null })).toBeNull();
  });

  it("marks every step as the template's result, never run, its output the bundled result", () => {
    const page = templatePage({ id: "busy-stations", version: 3 }, OPENED)!;
    expect(page.recipe.steps.map((s) => ({
      id: s.id, ordinal: s.ordinal, condition: s.condition, lastSuccessAt: s.lastSuccessAt, latestAttempt: s.latestAttempt,
      output: s.output, templateResult: s.templateResult,
    }))).toEqual([
      { id: "step-busy", ordinal: 0, condition: "current", lastSuccessAt: null, latestAttempt: null,
        output: { id: "template.busy-stations.3.result.step-busy", name: "busy_stations" }, templateResult: { template: "busy-stations", version: 3 } },
      { id: "step-rings", ordinal: 1, condition: "current", lastSuccessAt: null, latestAttempt: null,
        output: { id: "template.busy-stations.3.result.step-rings", name: "station_rings" }, templateResult: { template: "busy-stations", version: 3 } },
    ]);
  });

  it("names the workflow by the template's id, filed nowhere, its arrangement at the recipe's revision", () => {
    const page = templatePage({ id: "busy-stations", version: 3 }, OPENED)!;
    expect(page.recipe).toMatchObject({
      id: "template.busy-stations.3.workflow", name: "Busy stations", projectId: null, editRevision: "a".repeat(32),
      summary: { nodes: 2, sources: 1, liveOutputs: 2, status: "up_to_date" },
    });
    expect(page.layout.editRevision).toBe(page.recipe.editRevision);
    expect(page.layout).toMatchObject({ steps: { "step-busy": { x: 1, y: 2 } }, updatedAt: "2026-01-06T10:00:00.000Z" });
  });

  it("lists the datasets and results as the canvas's own, under their plain names and no one's", () => {
    const page = templatePage({ id: "busy-stations", version: 3 }, OPENED)!;
    expect(page.tables.map((t) => [t.name, t.qualifiedName, t.rowCount, t.geometryType, t.owner.sqlName, t.projectIds])).toEqual([
      ["stations", "stations", 6, "POINT", "template", []],
      ["districts", "districts", 2, "POLYGON", "template", []],
      ["busy_stations", "busy_stations", 4, "POINT", "template", []],
      ["station_rings", "station_rings", 4, "POLYGON", "template", []],
    ]);
  });
});

describe("what a copy brings, in words", () => {
  const step = (id: string) => ({ id, operation: "buffer", output: id, reads: ["stations"] });
  it("counts the map and the template's datasets for a map template", () => {
    expect(comesWith({ kind: "map", howMade: HOW, steps: null })).toBe("1 map and 2 datasets");
    expect(comesWith({ kind: "map", howMade: { ...HOW, datasets: HOW.datasets.slice(0, 1) }, steps: null })).toBe("1 map and 1 dataset");
  });

  it("counts the workflow and each step's result as a dataset for a workflow example", () => {
    expect(comesWith({ kind: "workflow", howMade: HOW, steps: [step("a"), step("b")] })).toBe("1 map, 1 workflow and 4 datasets");
  });
});
