// The Add data dialog mounted over a real upload queue engine: the gate
// it registers while mounted, the step it shows for a held file,
// Confirm's set going back to the engine as confirmed, the release on
// unmount, and the ways out of a pending step. Mounted through
// react-dom's client into the stored-tree host in./testing, in the node
// environment: no browser, no DOM library. The kit's Dialog is a box
// with a scrim button here; its own modality contract has its own
// proofs.
import { act, StrictMode, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataTable } from "./api";
import { AddDataDialog } from "./AddDataDialog";
import { GeometryApiError } from "./set-geometry/client";
import type { GeometryChoice, GeometryInspection, GeometryPreview, GeometrySetResult } from "./set-geometry/types";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { createUploadQueue, type UploadQueueEngine, type UploadTransportHandlers } from "./upload-queue";
import type { UploadQueue } from "./use-upload-queue";

type Deferred<T> = { resolve: (v: T) => void; reject: (e: unknown) => void; promise: Promise<T> };
const fake = vi.hoisted(() => {
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { resolve, reject, promise };
  }
  const inspects: Deferred<GeometryInspection>[] = [];
  const previews: { args: unknown[]; d: Deferred<GeometryPreview> }[] = [];
  const sets: { args: unknown[]; d: Deferred<GeometrySetResult> }[] = [];
  const client = {
    inspect: vi.fn(async () => { const d = deferred<GeometryInspection>(); inspects.push(d); return d.promise; }),
    preview: vi.fn(async (...args: unknown[]) => { const d = deferred<GeometryPreview>(); previews.push({ args, d }); return d.promise; }),
    set: vi.fn(async (...args: unknown[]) => { const d = deferred<GeometrySetResult>(); sets.push({ args, d }); return d.promise; }),
    projections: vi.fn(async () => ({ projections: [], resolved: null })),
  };
  const reset = () => { inspects.length = 0; previews.length = 0; sets.length = 0; client.inspect.mockClear(); client.preview.mockClear(); client.set.mockClear(); url.answer = null; url.capture = false; url.landing = null; };
  /** What the stubbed URL pane lands when its button is pressed; with
   * `capture` on, the press only captures the pane's callback, so the
   * test lands the answer later, as a fetch still running does. */
  const url: { answer: DataTable | null; capture: boolean; landing: ((t: DataTable) => void) | null } = { answer: null, capture: false, landing: null };
  return { deferred, inspects, previews, sets, client, reset, url };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./shell/use-project-name", () => ({ useProjectName: () => null }));
vi.mock("./ui/Dialog", () => ({
  Dialog: ({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) => (
    <div role="dialog" aria-label={label}><button data-scrim onClick={onClose}>scrim</button>{children}</div>
  ),
}));
// The URL pane's own road is's; here it lands the prepared answer on a
// press, so the dialog's wrapping of its hand-off is what is held.
vi.mock("./UrlImportPane", () => ({
  UrlImportPane: ({ onTableCreated }: { onTableCreated: (t: DataTable) => void }) => (
    <button data-land onClick={() => { if (fake.url.capture) fake.url.landing = onTableCreated; else if (fake.url.answer) onTableCreated(fake.url.answer); }}>land</button>
  ),
}));
vi.mock("./OverturePane", () => ({ OverturePane: () => null }));
vi.mock("./OsmPane", () => ({ OsmPane: () => null }));
vi.mock("./connections/PostgisPane", () => ({ PostgisPane: () => null }));
vi.mock("./set-geometry/client", async (original) => ({ ...(await original<typeof import("./set-geometry/client")>()), geometryClient: fake.client }));

const landed = (name: string, over: Partial<DataTable> = {}): DataTable => ({
  id: `id-${name}`, name, sourceFilename: `${name}.csv`, format: "csv", file: `tables/${name}.parquet`,
  geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 3,
  createdAt: "2026-09-13T10:00:00Z", source: "upload", sourceParams: null, importedAt: "2026-09-13T10:00:00Z", ...over,
});
/** The CSV road's answer for a weak file: evidence, nothing applied. */
const weak = (name: string) => landed(name, { geometryRecord: null, geometryCandidates: [] });
/** A GeoJSON's answer: no evidence, geometry in place. */
const strong = (name: string) => landed(name, { format: "geojson", sourceFilename: `${name}.geojson`, geometryColumn: "geometry", geometryType: "POINT" });
const columns = [{ name: "id", type: "BIGINT" }, { name: "x", type: "DOUBLE" }, { name: "y", type: "DOUBLE" }];
const pair: GeometryChoice = { format: "pair", columns: ["x", "y"] };
const inspection = (revision = "r1"): GeometryInspection => ({
  tableId: "t", revision, columns, geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified",
  candidates: [{ columns: ["x", "y"], format: "pair", signal: "content", rule: "content", strength: "weak", sample: { rows: 3, nonNull: 3, readable: 3 },
    crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, degreeCompatible: true, reasons: [], applied: false, sourceRetained: true, orientations: [{ lon: "x", lat: "y" }] }],
});
const answer: GeometryPreview = {
  tableId: "t", revision: "r1", choice: pair, canApply: true, issues: [], rowCount: 3, unreadableCount: 0, geometryType: "POINT", extent: [8, 50, 9, 51], degreeCompatible: true,
  sample: { rows: [{ index: 0, values: { id: 1, x: 8.5, y: 50.1 }, status: "readable" }], features: { type: "FeatureCollection", features: [] } },
};
const setResult = (name: string): GeometrySetResult => ({
  table: { ...landed(name, { geometryColumn: "geometry", geometryType: "POINT", crsAssumed: true }), sizeBytes: 1, projectIds: [], owner: { name: "Ada", sqlName: "ada" }, qualifiedName: name },
  revision: "r2", currentChoice: pair, mode: "set", extent: [8, 50, 9, 51],
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = <T,>(d: Deferred<T>, value: T) => act(async () => { d.resolve(value); await flush(); });

function fakeTransport() {
  const calls: { name: string; handlers: UploadTransportHandlers }[] = [];
  return { calls, transport: (file: File, handlers: UploadTransportHandlers) => { calls.push({ name: file.name, handlers }); } };
}
const files = (...names: string[]) => names.map((n) => new File(["content"], n));

/** The host screen's binding, over an injected engine: what
 * use-upload-queue does with the XHR transport, here with a hand-settled one. */
function Host({ engine, open, onClose, onTableCreated }: { engine: UploadQueueEngine; open: boolean; onClose: () => void; onTableCreated: (t: DataTable) => void }) {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const queue: UploadQueue = { ...snapshot, add: engine.add, dismiss: engine.dismiss, reset: engine.reset, current: engine.getSnapshot, registerMatchingGate: engine.registerMatchingGate, resolveMatching: engine.resolveMatching };
  return <AddDataDialog open={open} onClose={onClose} onTableCreated={onTableCreated} onPostgisTableCreated={() => {}} uploadQueue={queue} />;
}

describe("the Add data dialog over the upload queue", () => {
  let host: ReturnType<typeof installDomHost>;
  let container: HostElement;
  let root: ReturnType<typeof createRoot>;
  const imported = vi.fn();
  const stale = vi.fn();
  const onClose = vi.fn();
  const created = vi.fn();
  let calls: ReturnType<typeof fakeTransport>["calls"];
  let engine: UploadQueueEngine;
  const text = () => container.textContent;
  const button = (label: string) => container.querySelectorAll("button").find((b) => b.textContent === label);
  /** Under StrictMode, as the app runs in development: every effect is run, cleaned up and run again on mount. */
  const render = (open: boolean, strict = false) => act(async () => {
    const host = <Host engine={engine} open={open} onClose={onClose} onTableCreated={created} />;
    root.render(strict ? <StrictMode>{host}</StrictMode> : host);
  });
  const land = (index: number, table: DataTable) => act(async () => { calls[index].handlers.imported([table], []); await flush(); });

  beforeEach(() => {
    host = installDomHost();
    fake.reset();
    imported.mockClear(); stale.mockClear(); onClose.mockClear(); created.mockClear();
    const t = fakeTransport();
    calls = t.calls;
    engine = createUploadQueue(t.transport, { onFileImported: imported, onListingStale: stale });
    container = host.document.body.appendChild(host.document.createElement("div"));
    root = createRoot(container as unknown as Element);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.document.body.removeChild(container);
    host.uninstall();
  });

  it("the mounted dialog's gate holds a weak CSV, the step opens on it through the API, Confirm sends the set and the batch goes on with one landing notice and one refresh", async () => {
    await render(true);
    await act(async () => engine.add(files("weak_a.csv", "districts.geojson")));
    await land(0, weak("weak_a"));
    // Held: the landing notice fired once, the step shows for the file,
    // the next upload has not started, and the step opened on
    // the landed table inspect.
    expect(imported).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().matching?.name).toBe("weak_a.csv");
    expect(calls.map((c) => c.name)).toEqual(["weak_a.csv"]);
    expect(text()).toContain("Column matching");
    expect(text()).toContain("weak_a.csv");
    expect(text()).toContain("1 more file waits for this step: districts.geojson");
    expect(fake.client.inspect).toHaveBeenCalledWith("weak_a");
    await settle(fake.inspects[0], inspection());
    expect(fake.previews[0].args).toEqual(["weak_a", "r1", pair]);
    expect(button("Confirm")?.disabled).toBe(true);
    await settle(fake.previews[0].d, answer);
    expect(button("Confirm")?.disabled).toBe(false);
    await act(async () => { button("Confirm")!.click(); await flush(); });
    expect(fake.sets[0].args).toEqual(["weak_a", "r1", pair]);
    await settle(fake.sets[0].d, setResult("weak_a"));
    // Confirmed: the step is gone, the listing refresh fired once, the
    // landing notice did not fire again, and the next file started.
    expect(engine.getSnapshot().matching).toBeNull();
    expect(text()).not.toContain("Column matching");
    expect(stale).toHaveBeenCalledTimes(1);
    expect(imported).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.name)).toEqual(["weak_a.csv", "districts.geojson"]);
    await land(1, strong("districts"));
    expect(engine.getSnapshot().settled).toBe(true);
    expect(created).not.toHaveBeenCalled();
  });

  it("a GeoJSON landing behind the mounted dialog is never held, and neither is a CSV whose record applied", async () => {
    await render(true);
    await act(async () => engine.add(files("districts.geojson", "named.csv")));
    await land(0, strong("districts"));
    expect(engine.getSnapshot().entries[0].state).toBe("imported");
    expect(fake.client.inspect).not.toHaveBeenCalled();
    await land(1, landed("named", { geometryColumn: "geometry", geometryType: "POINT", geometryRecord: { columns: ["wkt"], format: "wkt", signal: "name", rule: "wkt-name", crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, unreadableCount: 0 }, geometryCandidates: [] }));
    expect(engine.getSnapshot().settled).toBe(true);
    expect(text()).not.toContain("Column matching");
  });

  it("unmounting the dialog with a step pending releases the gate, the step resolves plain with no write, and the next file starts", async () => {
    await render(true);
    await act(async () => engine.add(files("weak_a.csv", "weak_b.csv")));
    await land(0, weak("weak_a"));
    expect(engine.getSnapshot().matching?.name).toBe("weak_a.csv");
    await render(false);
    expect(engine.getSnapshot().entries[0].state).toBe("imported");
    expect(engine.getSnapshot().matching).toBeNull();
    expect(fake.client.set).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    // The batch went on without a gate: the second weak file lands plain.
    expect(calls.map((c) => c.name)).toEqual(["weak_a.csv", "weak_b.csv"]);
    await land(1, weak("weak_b"));
    expect(engine.getSnapshot().entries[1].state).toBe("imported");
    expect(engine.getSnapshot().settled).toBe(true);
  });

  it("the drop-anywhere order under StrictMode: a batch already running when the dialog mounts keeps the file behind queued through the gate's mount rehearsal, and the note names it once the first file is held (browser item b)", async () => {
    // The Data page's drop handler adds the files, then opens the dialog.
    await act(async () => engine.add(files("weak_a.csv", "strong_b.csv")));
    await render(true, true);
    // The gate was registered, released and registered again; the batch
    // is untouched: one request out, the second file still queued.
    expect(calls.map((c) => c.name)).toEqual(["weak_a.csv"]);
    expect(engine.getSnapshot().entries.map((e) => e.state)).toEqual(["uploading", "queued"]);
    await land(0, weak("weak_a"));
    expect(text()).toContain("Column matching");
    expect(text()).toContain("1 more file waits for this step: strong_b.csv");
    expect(calls).toHaveLength(1);
  });

  /** The URL road: the From URL tab, then the stubbed pane's landing. */
  const landFromUrl = async (table: DataTable) => {
    fake.url.answer = table;
    await act(async () => { button("From URL")!.click(); await flush(); });
    await act(async () => { container.querySelector("[data-land]")!.click(); await flush(); });
  };

  it("a URL import whose answer needs the step opens it and holds the host's hand-off; Confirm forwards the set's table once, and only then", async () => {
    await render(true);
    await landFromUrl(landed("weak_url", { source: "url", sourceParams: { url: "http://fixtures/weak_url.csv" }, geometryRecord: null, geometryCandidates: [] }));
    // Held: the host was not handed the table (which would close it).
    expect(created).not.toHaveBeenCalled();
    expect(text()).toContain("Column matching");
    expect(text()).toContain("weak_url.csv");
    expect(text()).not.toContain("wait for this step");
    expect(fake.client.inspect).toHaveBeenCalledWith("weak_url");
    await settle(fake.inspects[0], inspection());
    await settle(fake.previews[0].d, answer);
    await act(async () => { button("Confirm")!.click(); await flush(); });
    expect(created).not.toHaveBeenCalled();
    await settle(fake.sets[0].d, setResult("weak_url"));
    // The hand-off, once, with the table as it stands: set.
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toMatchObject({ name: "weak_url", geometryColumn: "geometry" });
    expect(text()).not.toContain("Column matching");
    expect(engine.getSnapshot().entries).toEqual([]);
  });

  it("Cancel on a URL step forwards the plain table once", async () => {
    await render(true);
    const plain = landed("weak_url", { source: "url", geometryRecord: null, geometryCandidates: [] });
    await landFromUrl(plain);
    await settle(fake.inspects[0], inspection());
    await act(async () => { button("Cancel")!.click(); await flush(); });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toBe(plain);
    expect(fake.client.set).not.toHaveBeenCalled();
    expect(text()).not.toContain("Column matching");
  });

  it("a URL answer without evidence is handed to the host at once, as today", async () => {
    await render(true);
    await landFromUrl(landed("remote", { source: "url", format: "geojson", geometryColumn: "geometry", geometryType: "POINT" }));
    expect(created).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Column matching");
    expect(fake.client.inspect).not.toHaveBeenCalled();
  });

  /** The URL road with the fetch still running: the press captures the pane's callback. */
  const startUrlImport = async () => {
    fake.url.capture = true;
    await act(async () => { button("From URL")!.click(); await flush(); });
    await act(async () => { container.querySelector("[data-land]")!.click(); await flush(); });
    expect(fake.url.landing).not.toBeNull();
  };

  it("a URL result that arrives after the dialog closed is handed to the host directly, once", async () => {
    await render(true);
    await startUrlImport();
    // The person closes the dialog while the import runs; the pane's
    // fetch finishes afterwards and calls the callback it captured.
    await act(async () => { container.querySelector("[data-scrim]")!.click(); await flush(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await render(false);
    const plain = landed("weak_url", { source: "url", geometryRecord: null, geometryCandidates: [] });
    await act(async () => { fake.url.landing!(plain); await flush(); });
    // Nobody can show a step: the host learns of the table, once, as it stands.
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toBe(plain);
    expect(fake.client.inspect).not.toHaveBeenCalled();
  });

  it("an active URL step is never replaced: an upload's step that lands meanwhile waits its turn, and each table is handed over once", async () => {
    await render(true);
    // A file upload in flight; the person switches to From URL, and a
    // weak CSV from there lands first: its step is active.
    await act(async () => engine.add(files("weak_a.csv")));
    const plainUrl = landed("weak_url", { source: "url", geometryRecord: null, geometryCandidates: [] });
    await landFromUrl(plainUrl);
    expect(text()).toContain("weak_url.csv");
    expect(fake.client.inspect).toHaveBeenCalledTimes(1);
    expect(fake.client.inspect).toHaveBeenCalledWith("weak_url");
    // The upload lands and needs the step: the engine holds it, and the
    // URL's step stays, draft and all.
    await land(0, weak("weak_a"));
    expect(engine.getSnapshot().matching?.name).toBe("weak_a.csv");
    expect(text()).toContain("weak_url.csv");
    expect(text()).not.toContain("weak_a.csv");
    expect(fake.client.inspect).toHaveBeenCalledTimes(1);
    // The URL step ends: its table is carried once, and the upload's step takes its turn.
    await settle(fake.inspects[0], inspection());
    await act(async () => { button("Cancel")!.click(); await flush(); });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toBe(plainUrl);
    expect(text()).toContain("weak_a.csv");
    expect(fake.client.inspect).toHaveBeenCalledWith("weak_a");
    await settle(fake.inspects[1], inspection());
    await act(async () => { button("Cancel")!.click(); await flush(); });
    expect(engine.getSnapshot().entries[0].state).toBe("imported");
    expect(engine.getSnapshot().settled).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("a URL result that arrives behind an active upload step waits, and the host's close on the batch's settlement still hands it over once", async () => {
    await render(true);
    await act(async () => engine.add(files("weak_a.csv")));
    // The URL import starts before the upload's step opens and finishes after it.
    await startUrlImport();
    await land(0, weak("weak_a"));
    expect(text()).toContain("weak_a.csv");
    const plainUrl = landed("weak_url", { source: "url", geometryRecord: null, geometryCandidates: [] });
    await act(async () => { fake.url.landing!(plainUrl); await flush(); });
    // The upload's step stays; the URL result waits and is not yet handed over.
    expect(text()).toContain("weak_a.csv");
    expect(text()).not.toContain("weak_url.csv");
    expect(created).not.toHaveBeenCalled();
    expect(fake.client.inspect).toHaveBeenCalledTimes(1);
    await settle(fake.inspects[0], inspection());
    await act(async () => { button("Cancel")!.click(); await flush(); });
    expect(engine.getSnapshot().settled).toBe(true);
    // The Data page closes on a clean settlement: the dialog unmounts with
    // the URL result still held. Settlement never discards it: the host
    // is handed the table, once, as it stands.
    await render(false);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toBe(plainUrl);
  });

  /** Reproduction from the review: a local upload in flight, a weak URL
   * CSV's step active, Confirm pressed with the set still out, then the
   * upload completing with geometry applied. The batch settles clean and
   * the Data host closes on it, unmounting the dialog under the set. */
  const closeDuringUrlConfirm = async () => {
    await render(true);
    await act(async () => engine.add(files("districts.geojson")));
    await landFromUrl(landed("weak_url", { source: "url", geometryRecord: null, geometryCandidates: [] }));
    await settle(fake.inspects[0], inspection());
    await settle(fake.previews[0].d, answer);
    await act(async () => { button("Confirm")!.click(); await flush(); });
    expect(fake.sets).toHaveLength(1);
    await land(0, strong("districts"));
    expect(engine.getSnapshot().settled).toBe(true);
    await render(false);
    // The set is still out: nothing is reported for the file yet, since
    // its outcome is not known.
    expect(created).not.toHaveBeenCalled();
  };

  it("the host closing during a URL step's Confirm waits for the set and hands the table over once, with the set's outcome", async () => {
    await closeDuringUrlConfirm();
    await settle(fake.sets[0].d, setResult("weak_url"));
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toMatchObject({ name: "weak_url", geometryColumn: "geometry" });
  });

  it("the same close with the set then refused hands the plain table over once: nobody is left to answer the refusal", async () => {
    await closeDuringUrlConfirm();
    await act(async () => { fake.sets[0].d.reject(new GeometryApiError("invalid_choice", "The chosen columns cannot be read.", 422)); await flush(); });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toMatchObject({ name: "weak_url", geometryColumn: null });
    expect(fake.client.set).toHaveBeenCalledTimes(1);
  });

  it("the close control with an upload step pending goes to the host, whose dismissal resolves the step plain with no write and stops the file behind", async () => {
    onClose.mockImplementation(() => engine.dismiss());
    await render(true);
    await act(async () => engine.add(files("weak_a.csv", "weak_b.csv")));
    await land(0, weak("weak_a"));
    await settle(fake.inspects[0], inspection());
    await act(async () => { container.querySelector('[aria-label="Close"]')!.click(); await flush(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().entries.map((e) => e.state)).toEqual(["imported", "not-started"]);
    expect(engine.getSnapshot().settled).toBe(true);
    expect(fake.client.set).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
  });

  it("while the set is in flight the close control and the kit's route (Escape, the scrim) are inert, and the outcome reported is the set's", async () => {
    onClose.mockImplementation(() => engine.dismiss());
    await render(true);
    await act(async () => engine.add(files("weak_a.csv")));
    await land(0, weak("weak_a"));
    await settle(fake.inspects[0], inspection());
    await settle(fake.previews[0].d, answer);
    await act(async () => { button("Confirm")!.click(); await flush(); });
    expect(fake.sets).toHaveLength(1);
    await act(async () => { container.querySelector('[aria-label="Close"]')!.click(); await flush(); });
    await act(async () => { container.querySelector("[data-scrim]")!.click(); await flush(); });
    await act(async () => { button("Cancel")!.click(); await flush(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(engine.getSnapshot().matching?.name).toBe("weak_a.csv");
    expect(text()).toContain("Column matching");
    await settle(fake.sets[0].d, setResult("weak_a"));
    expect(engine.getSnapshot().entries[0].state).toBe("imported");
    expect(stale).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Column matching");
    // The ways out are open again once the answer is in.
    await act(async () => { container.querySelector("[data-scrim]")!.click(); await flush(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close control with a URL step pending forwards the plain table once; the host closes on the table, not on the close", async () => {
    await render(true);
    const plain = landed("weak_url", { source: "url", geometryRecord: null, geometryCandidates: [] });
    await landFromUrl(plain);
    await settle(fake.inspects[0], inspection());
    await act(async () => { container.querySelector("[data-scrim]")!.click(); await flush(); });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toBe(plain);
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.client.set).not.toHaveBeenCalled();
  });

  it("a landing before the dialog mounts is the gateless bypass, and a later mount holds nothing retroactively", async () => {
    await act(async () => engine.add(files("weak_a.csv")));
    await land(0, weak("weak_a"));
    expect(engine.getSnapshot().entries[0].state).toBe("imported");
    await render(true);
    expect(engine.getSnapshot().matching).toBeNull();
    expect(text()).not.toContain("Column matching");
    expect(fake.client.inspect).not.toHaveBeenCalled();
  });
});
