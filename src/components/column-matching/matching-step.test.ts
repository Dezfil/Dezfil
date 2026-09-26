import { describe, expect, it, vi } from "vitest";
import type { GeometryCandidate } from "@/lib/geometry-evidence";
import type { DataTable, TableListing } from "../api";
import { GeometryApiError, type GeometryClient } from "../set-geometry/client";
import type { GeometryChoice, GeometryInspection, GeometryPreview, GeometrySetResult } from "../set-geometry/types";
import { createMatchingStep, type StepOutcome } from "./matching-step";

/**
 * The step's own thin layer over panel controller (plan): the file it is
 * for, the opening on the landed table, Confirm as the controller's
 * apply, Cancel as its cancel plus the file's resolution as a plain
 * table, every way out inert while the set is in flight, and the
 * hand-off at the step's end. Timing is the test's: every answer is a
 * promise the test settles.
 */

type Deferred<T> = { resolve: (v: T) => void; reject: (e: unknown) => void; promise: Promise<T> };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeClient() {
  const inspects: Deferred<GeometryInspection>[] = [];
  const previews: { args: [string, string, GeometryChoice]; d: Deferred<GeometryPreview> }[] = [];
  const sets: { args: [string, string, GeometryChoice]; d: Deferred<GeometrySetResult> }[] = [];
  const client: GeometryClient = {
    inspect: vi.fn(async () => { const d = deferred<GeometryInspection>(); inspects.push(d); return d.promise; }),
    preview: vi.fn(async (...args: [string, string, GeometryChoice]) => { const d = deferred<GeometryPreview>(); previews.push({ args, d }); return d.promise; }),
    set: vi.fn(async (...args: [string, string, GeometryChoice]) => { const d = deferred<GeometrySetResult>(); sets.push({ args, d }); return d.promise; }),
    projections: vi.fn(async () => ({ projections: [], resolved: null })),
  };
  return { client, inspects, previews, sets };
}

const landed: DataTable = {
  id: "t1", name: "weak_pair", sourceFilename: "weak_pair.csv", format: "csv", file: "tables/t1.parquet",
  geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 3,
  createdAt: "2026-09-13T10:00:00Z", source: "upload", sourceParams: null, importedAt: "2026-09-13T10:00:00Z",
  geometryRecord: null, geometryCandidates: [],
};
const columns = [
  { name: "id", type: "BIGINT" }, { name: "x", type: "DOUBLE" }, { name: "y", type: "DOUBLE" },
  { name: "lon", type: "DOUBLE" }, { name: "lat", type: "DOUBLE" },
];
/** The API's first candidate prefers a pair the fallback's column order
 * would not pick (`id`, `x`), and lists an orientation first that a
 * name-based guess would reverse: the step must read the API. */
const preferred: GeometryCandidate = {
  columns: ["lon", "lat"], format: "pair", signal: "content", rule: "content", strength: "weak",
  sample: { rows: 3, nonNull: 3, readable: 3 }, crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" },
  degreeCompatible: true, reasons: [], applied: false, sourceRetained: true,
  orientations: [{ lon: "lat", lat: "lon" }, { lon: "lon", lat: "lat" }],
};
const inspection = (candidates: GeometryCandidate[], revision = "r1"): GeometryInspection => ({
  tableId: "t1", revision, columns, geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified", candidates,
});
const answer = (choice: GeometryChoice, revision = "r1"): GeometryPreview => ({
  tableId: "t1", revision, choice, canApply: true, issues: [], rowCount: 3, unreadableCount: 0, geometryType: "POINT",
  extent: [8, 50, 9, 51], degreeCompatible: true,
  sample: { rows: [{ index: 0, values: { id: 1 }, status: "readable" }], features: { type: "FeatureCollection", features: [] } },
});
const setResult = (choice: GeometryChoice): GeometrySetResult => ({
  table: { ...landed, geometryColumn: "geometry", geometryType: "POINT", crsAssumed: true, sizeBytes: 10, projectIds: [] } as TableListing,
  revision: "r2", currentChoice: choice, mode: "set", extent: [8, 50, 9, 51],
});

async function opened(candidates: GeometryCandidate[]) {
  const fake = fakeClient();
  const resolved: { outcome: StepOutcome; table: DataTable }[] = [];
  const step = createMatchingStep({ client: fake.client, table: landed, onResolved: (outcome, table) => resolved.push({ outcome, table }) });
  const opening = step.open();
  fake.inspects[0].resolve(inspection(candidates));
  await opening;
  await flush();
  return { ...fake, step, resolved };
}

describe("the column-matching step's state", () => {
  it("opens filled in with the API's first candidate in its first listed orientation, the projection implicit, and previews it against the read revision", async () => {
    const { step, previews } = await opened([preferred]);
    const { panel } = step.getState();
    expect(panel.phase).toBe("open");
    expect(panel.mode).toBe("first");
    expect(panel.choice).toEqual({ format: "pair", columns: ["lat", "lon"], projection: { kind: "implicit", code: null, text: "" } });
    expect(previews).toHaveLength(1);
    // The request carries the revision and no code: an untouched Confirm
    // sends none and the dataset stays assumed.
    expect(previews[0].args).toEqual(["weak_pair", "r1", { format: "pair", columns: ["lat", "lon"] }]);
  });

  it("with no candidate, opens on the first format with the first columns it accepts, in column order", async () => {
    const { step, previews } = await opened([]);
    expect(step.getState().panel.choice.format).toBe("pair");
    expect(step.getState().panel.choice.columns).toEqual(["id", "x"]);
    expect(previews[0].args[2]).toEqual({ format: "pair", columns: ["id", "x"] });
  });

  it("Confirm waits for a readable, applicable preview, then sends the set with the read revision and resolves confirmed with the set's table", async () => {
    const { step, previews, sets, resolved } = await opened([preferred]);
    // Nothing readable yet: Confirm is off and a press sends nothing.
    expect(step.getState().confirmable).toBe(false);
    await step.confirm();
    expect(sets).toHaveLength(0);
    previews[0].d.resolve(answer({ format: "pair", columns: ["lat", "lon"] }));
    await flush();
    expect(step.getState().confirmable).toBe(true);
    const confirming = step.confirm();
    expect(sets[0].args).toEqual(["weak_pair", "r1", { format: "pair", columns: ["lat", "lon"] }]);
    sets[0].d.resolve(setResult({ format: "pair", columns: ["lat", "lon"] }));
    await confirming;
    expect(resolved).toEqual([{ outcome: "confirmed", table: expect.objectContaining({ name: "weak_pair", geometryColumn: "geometry" }) }]);
    expect(step.getState().resolved).toBe("confirmed");
    expect(step.getState().panel.phase).toBe("closed");
  });

  it("a refusal leaves the step open with the choice intact and the API's sentence verbatim; input_changed re-reads before the next attempt", async () => {
    const { step, previews, sets, resolved, inspects } = await opened([preferred]);
    previews[0].d.resolve(answer({ format: "pair", columns: ["lat", "lon"] }));
    await flush();
    const confirming = step.confirm();
    sets[0].d.reject(new GeometryApiError("input_changed", "The dataset changed under you: revision r1 is not current.", 409));
    await flush();
    const { panel } = step.getState();
    expect(panel.phase).toBe("open");
    expect(panel.choice.columns).toEqual(["lat", "lon"]);
    expect(panel.refusal).toBe("The dataset changed under you: revision r1 is not current.");
    expect(resolved).toEqual([]);
    expect(step.getState().resolved).toBeNull();
    // The re-read: a second inspection, then the same choice previewed
    // against the new revision before the next attempt; the
    // apply's own promise settles only once the re-read has.
    expect(inspects).toHaveLength(2);
    expect(step.getState().confirmable).toBe(false);
    inspects[1].resolve(inspection([preferred], "r2"));
    await confirming;
    await flush();
    expect(previews).toHaveLength(2);
    expect(previews[1].args[1]).toBe("r2");
    // Settled, the refused Confirm has closed nothing: the step is still
    // the person's to answer.
    expect(step.getState().resolved).toBeNull();
    expect(step.getState().panel.phase).toBe("open");
    expect(resolved).toEqual([]);
  });

  it("Cancel writes nothing and resolves closed with the landed table; a second way out resolves nothing again", async () => {
    const { step, sets, resolved } = await opened([preferred]);
    expect(step.cancel()).toBe(true);
    expect(sets).toHaveLength(0);
    expect(resolved).toEqual([{ outcome: "closed", table: landed }]);
    expect(step.getState().panel.phase).toBe("closed");
    expect(step.cancel()).toBe(true);
    expect(resolved).toHaveLength(1);
  });

  it("while the set is in flight every way out is inert, and the outcome reported is the set's", async () => {
    const { step, previews, sets, resolved } = await opened([preferred]);
    previews[0].d.resolve(answer({ format: "pair", columns: ["lat", "lon"] }));
    await flush();
    const confirming = step.confirm();
    expect(step.getState().busy).toBe(true);
    // Cancel, the close control and Escape all come through here and are
    // refused until the answer: a plain table is never reported for a
    // file whose set may have committed.
    expect(step.cancel()).toBe(false);
    expect(step.cancel()).toBe(false);
    expect(resolved).toEqual([]);
    sets[0].d.resolve(setResult({ format: "pair", columns: ["lat", "lon"] }));
    await confirming;
    expect(resolved.map((r) => r.outcome)).toEqual(["confirmed"]);
    expect(step.getState().busy).toBe(false);
  });

  it("after a refused set the ways out open again and Cancel resolves the plain table", async () => {
    const { step, previews, sets, resolved } = await opened([preferred]);
    previews[0].d.resolve(answer({ format: "pair", columns: ["lat", "lon"] }));
    await flush();
    const confirming = step.confirm();
    expect(step.cancel()).toBe(false);
    sets[0].d.reject(new GeometryApiError("geometry_in_flight", "A geometry edit or refresh is already running for this dataset or import group.", 409));
    await confirming;
    expect(step.getState().panel.refusal).toBe("A geometry edit or refresh is already running for this dataset or import group.");
    expect(step.cancel()).toBe(true);
    expect(resolved).toEqual([{ outcome: "closed", table: landed }]);
  });

  it("settling under a gone host decides the file once: plain at once with no set out, else the set's answer, confirmed on success and plain on a refusal", async () => {
    const idle = await opened([preferred]);
    idle.step.settle();
    expect(idle.resolved).toEqual([{ outcome: "closed", table: landed }]);
    idle.step.settle();
    expect(idle.resolved).toHaveLength(1);

    const confirmed = await opened([preferred]);
    confirmed.previews[0].d.resolve(answer({ format: "pair", columns: ["lat", "lon"] }));
    await flush();
    const confirming = confirmed.step.confirm();
    confirmed.step.settle();
    expect(confirmed.resolved).toEqual([]);
    confirmed.sets[0].d.resolve(setResult({ format: "pair", columns: ["lat", "lon"] }));
    await confirming;
    expect(confirmed.resolved.map((r) => [r.outcome, r.table.geometryColumn])).toEqual([["confirmed", "geometry"]]);

    const refused = await opened([preferred]);
    refused.previews[0].d.resolve(answer({ format: "pair", columns: ["lat", "lon"] }));
    await flush();
    const failing = refused.step.confirm();
    refused.step.settle();
    refused.sets[0].d.reject(new GeometryApiError("invalid_choice", "The chosen columns cannot be read.", 422));
    await failing;
    expect(refused.resolved).toEqual([{ outcome: "closed", table: landed }]);
    expect(refused.step.getState().panel.phase).toBe("closed");
  });

  it("an inspection the API refuses leaves the step unopened with the sentence, and Cancel still resolves the plain table", async () => {
    const fake = fakeClient();
    const resolved: StepOutcome[] = [];
    const step = createMatchingStep({ client: fake.client, table: landed, onResolved: (outcome) => resolved.push(outcome) });
    const opening = step.open();
    fake.inspects[0].reject(new GeometryApiError("geometry_not_supported", "This dataset's source cannot carry a geometry choice.", 409));
    await opening;
    expect(step.getState().panel.phase).toBe("closed");
    expect(step.getState().panel.openError).toBe("This dataset's source cannot carry a geometry choice.");
    expect(step.cancel()).toBe(true);
    expect(resolved).toEqual(["closed"]);
  });
});
