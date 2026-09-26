import type { GeometryRecord } from "@/lib/geometry-evidence";
import { describe, expect, it, vi } from "vitest";
import { GeometryApiError, type GeometryClient } from "./client";
import { readout } from "./derivations";
import { applyEnabled, createPanelController, type PanelController } from "./panel-controller";
import type { GeometryChoice, GeometryInspection, GeometryPreview, GeometrySetResult } from "./types";

type Deferred<T> = { resolve: (v: T) => void; reject: (e: unknown) => void; promise: Promise<T> };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const inspection = (over: Partial<GeometryInspection> = {}): GeometryInspection => ({
  tableId: "t", revision: "r1",
  columns: [{ name: "id", type: "BIGINT" }, { name: "payload", type: "VARCHAR" }, { name: "x", type: "DOUBLE" }, { name: "y", type: "DOUBLE" }],
  geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified",
  candidates: [{ columns: ["payload"], format: "wkt", signal: "content", rule: "content", strength: "weak", sample: { rows: 3, nonNull: 3, readable: 2 },
    crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, degreeCompatible: true, reasons: [], applied: false, sourceRetained: true }],
  ...over,
});
function answer(choice: GeometryChoice, over: Partial<GeometryPreview> = {}, statuses: GeometryPreview["sample"]["rows"][number]["status"][] = ["readable", "unreadable", "missing"]): GeometryPreview {
  return {
    tableId: "t", revision: "r1", choice, canApply: true, issues: [], rowCount: 3, unreadableCount: 1, geometryType: "POINT",
    extent: [10, 20, 10, 20], degreeCompatible: true,
    sample: { rows: statuses.map((status, index) => ({ index, values: { payload: "POINT(10 20)" }, status })),
      features: { type: "FeatureCollection", features: statuses.map((s, id) => ({ type: "Feature", id, geometry: s === "readable" ? { type: "Point", coordinates: [10, 20] } : null, properties: {} })) } },
    ...over,
  };
}

/** A client whose every call is a hand-settled promise, in call order. */
function fakeClient(first: GeometryInspection = inspection()) {
  const previews: { revision: string; choice: GeometryChoice; d: Deferred<GeometryPreview> }[] = [];
  const sets: { revision: string; choice: GeometryChoice; d: Deferred<GeometrySetResult> }[] = [];
  const inspects: Deferred<GeometryInspection>[] = [];
  const client: GeometryClient = {
    inspect: vi.fn(async () => { const d = deferred<GeometryInspection>(); inspects.push(d); return d.promise; }),
    preview: vi.fn(async (_n, revision, choice) => { const d = deferred<GeometryPreview>(); previews.push({ revision, choice, d }); return d.promise; }),
    set: vi.fn(async (_n, revision, choice) => { const d = deferred<GeometrySetResult>(); sets.push({ revision, choice, d }); return d.promise; }),
    projections: vi.fn(async () => ({ projections: [], resolved: null })),
  };
  return { client, previews, sets, inspects, first };
}
async function opened(over: Partial<GeometryInspection> = {}, table = { geometryColumn: null as string | null, crsAssumed: false }) {
  const fake = fakeClient(inspection(over));
  const onApplied = vi.fn();
  const c = createPanelController({ client: fake.client, name: "trips" });
  c.configure({ onApplied });
  const opening = c.open(table);
  await flush();
  fake.inspects[0].resolve(fake.first);
  await opening;
  return { ...fake, c, onApplied };
}
const wkt: GeometryChoice = { format: "wkt", columns: ["payload"] };

describe("the set-geometry panel controller", () => {
  it("opening previews the opening choice once, with the read revision and the choice", async () => {
    const { c, previews } = await opened();
    expect(c.getState().phase).toBe("open");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ revision: "r1", choice: wkt });
    expect(c.getState().preview.status).toBe("pending");
  });
  it("every control change sends one preview; an older answer resolving after a newer one cannot repaint it, and the last answer stays while one is in flight", async () => {
    const { c, previews } = await opened();
    previews[0].d.resolve(answer(wkt));
    await flush();
    expect(c.getState().preview.status).toBe("ready");
    c.setFormat("wkb");
    c.setFormat("pair");
    expect(previews).toHaveLength(3);
    expect(previews[1].choice).toEqual({ format: "wkb", columns: ["payload"] });
    expect(previews[2].choice).toEqual({ format: "pair", columns: ["payload", "id"] });
    // In flight: the WKT answer is still what the page draws.
    expect(c.getState().preview.status).toBe("pending");
    expect(c.getState().preview.answer?.choice).toEqual(wkt);
    // The newer (pair) answer lands first, then the superseded WKB one.
    previews[2].d.resolve(answer(previews[2].choice, { geometryType: "POINT" }));
    await flush();
    expect(c.getState().preview.answer?.choice).toEqual(previews[2].choice);
    previews[1].d.resolve(answer(previews[1].choice, { geometryType: "MIXED" }));
    await flush();
    expect(c.getState().preview.answer?.choice).toEqual(previews[2].choice);
    expect(c.getState().preview.answer?.geometryType).toBe("POINT");
    expect(c.getState().preview.status).toBe("ready");
  });
  it("Apply is on only for a successful, applicable preview of the current choice; a pending or failed preview inherits nothing", async () => {
    const { c, previews, sets, client } = await opened();
    expect(applyEnabled(c.getState())).toBe(false);
    previews[0].d.resolve(answer(wkt));
    await flush();
    expect(applyEnabled(c.getState())).toBe(true);
    // A delayed zero-readable choice: Apply attempted during the delay must not reach the API.
    c.setFormat("wkb");
    expect(applyEnabled(c.getState())).toBe(false);
    await c.apply();
    expect(client.set).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
    previews[1].d.resolve(answer(previews[1].choice, { geometryType: null, extent: null }, ["unreadable", "unreadable", "missing"]));
    await flush();
    expect(applyEnabled(c.getState())).toBe(false);
    // The API says the choice cannot apply.
    c.setFormat("wkt");
    previews[2].d.resolve(answer(wkt, { canApply: false, issues: [{ code: "projection_required", message: "Choose the projection." }] }));
    await flush();
    expect(applyEnabled(c.getState())).toBe(false);
    // A failed preview.
    c.setFormat("wkb");
    previews[3].d.reject(new GeometryApiError("column_unavailable", 'Column "payload" is no longer available.', 400));
    await flush();
    expect(c.getState().preview.status).toBe("failed");
    expect(c.getState().preview.message).toBe('Column "payload" is no longer available.');
    expect(applyEnabled(c.getState())).toBe(false);
  });
  it("apply sends the choice with the read revision; on success the panel closes and the page is told", async () => {
    const { c, previews, sets, onApplied } = await opened();
    previews[0].d.resolve(answer(wkt));
    await flush();
    const applying = c.apply();
    await flush();
    expect(sets[0]).toMatchObject({ revision: "r1", choice: wkt });
    expect(c.getState().applying).toBe(true);
    const result = { table: { name: "trips" }, revision: "r2", currentChoice: wkt, mode: "set", extent: null } as unknown as GeometrySetResult;
    sets[0].d.resolve(result);
    await applying;
    expect(c.getState().phase).toBe("closed");
    expect(onApplied).toHaveBeenCalledWith(result);
  });
  it.each([
    [409, "geometry_in_flight", "A geometry edit or refresh is already running for this dataset or import group."],
    [422, "geometry_choice_invalid", "The original geometry source is no longer stored. A further change is unavailable."],
    [422, "geometry_choice_invalid", "The declared CRS EPSG:25833 conflicts with the chosen EPSG:25832."],
    [409, "geometry_not_supported", "Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own."],
    [404, "not_found", "That dataset was deleted. Its name now belongs to another dataset."],
  ])("a %s %s refusal is shown as the API words it, the panel open and the choice intact", async (status, code, message) => {
    const { c, previews, sets, client } = await opened();
    previews[0].d.resolve(answer(wkt));
    await flush();
    const applying = c.apply();
    await flush();
    sets[0].d.reject(new GeometryApiError(code, message, status));
    await applying;
    expect(c.getState().refusal).toBe(message);
    expect(c.getState().phase).toBe("open");
    expect(c.getState().choice.columns).toEqual(["payload"]);
    expect(client.inspect).toHaveBeenCalledTimes(1);
  });
  it("after a stale-revision refusal the panel re-reads its inspection and previews against the new revision before the next attempt", async () => {
    const { c, previews, sets, inspects, client } = await opened();
    previews[0].d.resolve(answer(wkt));
    await flush();
    const applying = c.apply();
    await flush();
    sets[0].d.reject(new GeometryApiError("input_changed", "The dataset changed. Inspect its geometry again before continuing.", 409));
    await flush();
    expect(c.getState().refusal).toBe("The dataset changed. Inspect its geometry again before continuing.");
    expect(client.inspect).toHaveBeenCalledTimes(2);
    expect(applyEnabled(c.getState())).toBe(false);
    inspects[1].resolve(inspection({ revision: "r2" }));
    await applying;
    await flush();
    expect(c.getState().inspection?.revision).toBe("r2");
    expect(previews[1]).toMatchObject({ revision: "r2", choice: wkt });
    previews[1].d.resolve(answer(wkt, { revision: "r2" }));
    await flush();
    expect(applyEnabled(c.getState())).toBe(true);
    void c.apply();
    await flush();
    expect(sets[1].revision).toBe("r2");
  });
  it("Cancel writes nothing and closes the panel; an answer landing afterwards is discarded", async () => {
    const { c, previews, client } = await opened();
    c.cancel();
    expect(c.getState().phase).toBe("closed");
    expect(client.set).not.toHaveBeenCalled();
    previews[0].d.resolve(answer(wkt));
    await flush();
    expect(c.getState().preview.answer).toBeNull();
  });
  it("the native path sends no preview on open, previews once a projection is chosen, and applies with the code", async () => {
    const { c, previews, sets, client } = await opened(
      { columns: [{ name: "id", type: "BIGINT" }, { name: "geometry", type: "GEOMETRY" }], geometryColumn: "geometry", candidates: [] },
      { geometryColumn: "geometry", crsAssumed: true },
    );
    expect(client.preview).not.toHaveBeenCalled();
    expect(c.getState().marked).toBe(true);
    expect(c.getState().preview.status).toBe("idle");
    c.chooseProjection("25833");
    expect(previews[0]).toMatchObject({ revision: "r1", choice: { format: "wkb", columns: ["geometry"], epsg: 25833 } });
    previews[0].d.resolve(answer(previews[0].choice));
    await flush();
    expect(applyEnabled(c.getState())).toBe(true);
    void c.apply();
    await flush();
    expect(sets[0].choice).toEqual({ format: "wkb", columns: ["geometry"], epsg: 25833 });
  });
  it("an inspection the API refuses closes nothing and carries the refusal for the page", async () => {
    const fake = fakeClient();
    const c: PanelController = createPanelController({ client: fake.client, name: "sketch" });
    const opening = c.open({ geometryColumn: null, crsAssumed: false });
    await flush();
    fake.inspects[0].reject(new GeometryApiError("geometry_not_supported", "Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own.", 409));
    await opening;
    expect(c.getState().phase).toBe("closed");
    expect(c.getState().openError).toBe("Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own.");
  });
  it("dismissing clears the shown refusal, and the inspection's, leaving the choice intact", async () => {
    const fake = fakeClient();
    const c = createPanelController({ client: fake.client, name: "sketch" });
    const opening = c.open({ geometryColumn: null, crsAssumed: false });
    await flush();
    fake.inspects[0].reject(new GeometryApiError("geometry_not_supported", "refused", 409));
    await opening;
    expect(c.getState().openError).toBe("refused");
    c.dismiss();
    expect(c.getState().openError).toBeNull();
    const { c: open, previews, sets } = await opened();
    previews[0].d.resolve(answer(wkt));
    await flush();
    const applying = open.apply();
    await flush();
    sets[0].d.reject(new GeometryApiError("geometry_in_flight", "busy", 409));
    await applying;
    expect(open.getState().refusal).toBe("busy");
    open.dismiss();
    expect(open.getState()).toMatchObject({ refusal: null, phase: "open", choice: { columns: ["payload"] } });
  });
  it("the chip's open marks the projection field on a retained-source assumed dataset, and a chosen code clears the mark", async () => {
    const fake = fakeClient(inspection({ geometryColumn: "geometry", currentChoice: wkt }));
    const c = createPanelController({ client: fake.client, name: "trips" });
    const opening = c.open({ geometryColumn: "geometry", crsAssumed: true }, null, { markProjection: true });
    await flush();
    fake.inspects[0].resolve(fake.first);
    await opening;
    expect(c.getState().marked).toBe(true);
    expect(c.getState().choice.columns).toEqual(["payload"]);
    c.chooseProjection("4326");
    expect(c.getState().marked).toBe(false);
  });
  it("an older opening's inspection resolving after a newer opening cannot win; the newer seed holds", async () => {
    const fake = fakeClient();
    const c = createPanelController({ client: fake.client, name: "trips" });
    const first = c.open({ geometryColumn: null, crsAssumed: false });
    await flush();
    const second = c.open({ geometryColumn: null, crsAssumed: false }, { format: "pair", columns: ["x", "y"] });
    await flush();
    expect(fake.inspects).toHaveLength(2);
    fake.inspects[0].resolve(fake.first);
    await first;
    expect(c.getState().phase, "the superseded opening opens nothing").toBe("opening");
    expect(fake.previews).toHaveLength(0);
    fake.inspects[1].resolve(fake.first);
    await second;
    expect(c.getState()).toMatchObject({ phase: "open", choice: { format: "pair", columns: ["x", "y"] } });
    expect(fake.previews).toHaveLength(1);
    expect(fake.previews[0].choice).toEqual({ format: "pair", columns: ["x", "y"] });
  });
  it("an older opening's failure cannot close a newer, already open panel", async () => {
    const fake = fakeClient();
    const c = createPanelController({ client: fake.client, name: "trips" });
    const first = c.open({ geometryColumn: null, crsAssumed: false });
    await flush();
    const second = c.open({ geometryColumn: null, crsAssumed: false }, { format: "pair", columns: ["x", "y"] });
    await flush();
    fake.inspects[1].resolve(fake.first);
    await second;
    expect(c.getState().phase).toBe("open");
    fake.inspects[0].reject(new GeometryApiError("geometry_not_supported", "refused", 409));
    await first;
    expect(c.getState().phase).toBe("open");
    expect(c.getState().openError).toBeNull();
    expect(c.getState().choice.columns).toEqual(["x", "y"]);
  });
  it("a stale-revision re-read that lands after Cancel and a reopen cannot replace the reopened panel's inspection", async () => {
    const { c, previews, sets, inspects } = await opened();
    previews[0].d.resolve(answer(wkt));
    await flush();
    const applying = c.apply();
    await flush();
    sets[0].d.reject(new GeometryApiError("input_changed", "The dataset changed. Inspect its geometry again before continuing.", 409));
    await flush();
    expect(inspects).toHaveLength(2);
    c.cancel();
    const reopen = c.open({ geometryColumn: null, crsAssumed: false }, { format: "pair", columns: ["x", "y"] });
    await flush();
    expect(inspects).toHaveLength(3);
    inspects[2].resolve(inspection({ revision: "r2" }));
    await reopen;
    expect(c.getState()).toMatchObject({ phase: "open", inspection: { revision: "r2" }, choice: { columns: ["x", "y"] } });
    inspects[1].resolve(inspection({ revision: "r0" }));
    await applying;
    await flush();
    expect(c.getState().inspection?.revision).toBe("r2");
    expect(c.getState().rereading).toBe(false);
    expect(previews.at(-1)).toMatchObject({ revision: "r2", choice: { format: "pair", columns: ["x", "y"] } });
  });
  it("the address opens the panel once per dataset; after the apply's close, the page's re-read cannot reopen it, while a door still can", async () => {
    const fake = fakeClient();
    const c = createPanelController({ client: fake.client, name: "trips" });
    c.configure({ onApplied: vi.fn() });
    const facts = { geometryColumn: null, crsAssumed: false };
    const byAddress = c.openByAddress(facts);
    await flush();
    fake.inspects[0].resolve(fake.first);
    await byAddress;
    expect(c.getState().phase).toBe("open");
    fake.previews[0].d.resolve(answer(wkt));
    await flush();
    const applying = c.apply();
    await flush();
    fake.sets[0].d.resolve({ table: { name: "trips" }, revision: "r2", currentChoice: wkt, mode: "set", extent: null } as unknown as GeometrySetResult);
    await applying;
    expect(c.getState().phase).toBe("closed");
    // The page re-reads and its screen mounts again with the same address.
    await c.openByAddress({ geometryColumn: "geometry", crsAssumed: true });
    expect(c.getState().phase, "closed after apply stays closed").toBe("closed");
    expect(fake.client.inspect).toHaveBeenCalledTimes(1);
    void c.open({ geometryColumn: "geometry", crsAssumed: true });
    expect(c.getState().phase).toBe("opening");
  });
  it("a retained answer keeps the CRS context it was read under; a stale-revision re-read that installs a record declaring another projection relabels nothing until its own preview answers", async () => {
    const assumed: GeometryRecord = { columns: ["payload"], format: "wkt", signal: "content", rule: "content", crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, unreadableCount: 0 };
    const declared: GeometryRecord = { ...assumed, crs: { stance: "declared", srid: 25833, label: "ETRS89 / UTM 33N" } };
    const { c, previews, sets, inspects } = await opened({ geometryColumn: "payload", geometryRecord: assumed, currentChoice: wkt }, { geometryColumn: "payload", crsAssumed: true });
    previews[0].d.resolve(answer(wkt));
    await flush();
    const label = () => readout(c.getState().preview.answer, c.getState().preview.answerRecord)?.[2];
    expect(c.getState().preview.answerRecord).toEqual(assumed);
    expect(label()).toBe("WGS 84");
    const applying = c.apply();
    await flush();
    sets[0].d.reject(new GeometryApiError("input_changed", "The dataset changed. Inspect its geometry again before continuing.", 409));
    await flush();
    inspects[1].resolve(inspection({ revision: "r2", geometryColumn: "payload", geometryRecord: declared, currentChoice: wkt }));
    await applying;
    await flush();
    // The replacement preview is pending: the r1 answer stays on the page, labelled as it was read.
    expect(c.getState()).toMatchObject({ inspection: { revision: "r2", geometryRecord: declared }, preview: { status: "pending", answer: { revision: "r1" } } });
    expect(c.getState().preview.answerRecord).toEqual(assumed);
    expect(label()).toBe("WGS 84");
    previews[1].d.resolve(answer(wkt, { revision: "r2" }));
    await flush();
    expect(c.getState().preview.answerRecord).toEqual(declared);
    expect(label()).toBe("ETRS89 / UTM 33N");
  });
  it("switching to H3 or GeoJSON sends no projection even after a code was chosen for a pair", async () => {
    const { c, previews } = await opened();
    c.setFormat("pair");
    c.chooseProjection("25833");
    expect(previews.at(-1)?.choice).toEqual({ format: "pair", columns: ["payload", "id"], epsg: 25833 });
    c.setFormat("h3");
    expect(previews.at(-1)?.choice).toEqual({ format: "h3", columns: ["payload"] });
  });
});

describe("a slow inspection (09-14)", () => {
  it("is waited for as long as the server needs: no client-side limit closes the opening or invents a refusal", async () => {
    // A guard, not a red-proven repair: the client never had a timeout.
    // It goes red the day an AbortSignal.timeout or a race against a timer
    // is added to the open path.
    vi.useFakeTimers();
    try {
      const fake = fakeClient();
      const c = createPanelController({ client: fake.client, name: "trajectories" });
      const opening = c.open({ geometryColumn: null, crsAssumed: false });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(c.getState().phase).toBe("opening");
      expect(c.getState().openError).toBeNull();
      fake.inspects[0].resolve(inspection());
      await opening;
      expect(c.getState().phase).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

it("field round: every door announces opening before the inspection, including the once-only address", async () => {
  const fake = fakeClient();
  const c = createPanelController({ client: fake.client, name: "trips" });
  const onOpen = vi.fn();
  c.configure({ onApplied: vi.fn(), onOpen });
  const facts = { geometryColumn: null, crsAssumed: false };
  for (const open of [() => c.open(facts), () => c.open(facts, { format: "pair", columns: ["x", "y"] }),
    () => c.open(facts, null, { markProjection: true }), () => c.openByAddress(facts)]) {
    onOpen.mockClear();
    const pending = open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(c.getState().phase).toBe("opening");
    fake.inspects.at(-1)!.resolve(inspection());
    await pending;
    c.cancel();
  }
  onOpen.mockClear();
  await c.openByAddress(facts);
  expect(onOpen).not.toHaveBeenCalled();
});

it("field round: an address opening can switch tabs before the parent's callback effect runs", async () => {
  const fake = fakeClient();
  const onOpen = vi.fn();
  const c = createPanelController({ client: fake.client, name: "trips", onOpen });
  // Child mount effects run before the parent's configure effect.
  const pending = c.openByAddress({ geometryColumn: null, crsAssumed: false });
  expect(onOpen).toHaveBeenCalledTimes(1);
  fake.inspects[0].resolve(inspection());
  await pending;
});
