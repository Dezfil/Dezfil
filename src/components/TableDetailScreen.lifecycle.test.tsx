// The one test in this folder that mounts the screen and lets its effects run: the address's open
// is a mount-time effect, and the page's re-read after an apply unmounts and remounts the detail
// under the same address. A static render cannot see either. It mounts through react-dom's client
// into the stored-tree host in./testing, in the suite's own node environment: no browser, no DOM
// library.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableInspection } from "./api";
import type { GeometryChoice, GeometryInspection, GeometryPreview, GeometrySetResult } from "./set-geometry/types";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { TableDetailScreen } from "./TableDetailScreen";

type Deferred<T> = { resolve: (v: T) => void; promise: Promise<T> };
const fake = vi.hoisted(() => {
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { resolve, promise };
  }
  const reads: Deferred<{ ok: boolean; json: () => Promise<unknown> }>[] = [];
  const inspects: Deferred<GeometryInspection>[] = [];
  const previews: Deferred<GeometryPreview>[] = [];
  const sets: Deferred<GeometrySetResult>[] = [];
  const client = {
    inspect: vi.fn(async () => { const d = deferred<GeometryInspection>(); inspects.push(d); return d.promise; }),
    preview: vi.fn(async () => { const d = deferred<GeometryPreview>(); previews.push(d); return d.promise; }),
    set: vi.fn(async () => { const d = deferred<GeometrySetResult>(); sets.push(d); return d.promise; }),
    projections: vi.fn(async () => ({ projections: [], resolved: null })),
  };
  return { deferred, reads, inspects, previews, sets, client };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tables/trips" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => <div data-page-map="" /> }));
vi.mock("./set-geometry/ChoicePreviewMap", () => ({ ChoicePreviewMap: () => <div data-choice-preview="" /> }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("./set-geometry/client", async (original) => ({ ...(await original<typeof import("./set-geometry/client")>()), geometryClient: fake.client }));

const before: TableInspection = {
  id: "fixture", name: "trips", sourceFilename: "trips.csv", file: "tables/fixture.parquet", format: "csv", geometryColumn: null, geometryType: null,
  crsAssumed: false, headerSuspect: false, rowCount: 1000, source: "upload", sourceParams: null, createdAt: "2026-09-13T10:00:00Z", importedAt: "2026-09-13T10:00:00Z",
  columns: [{ name: "id", type: "BIGINT" }, { name: "column01", type: "VARCHAR" }], preview: [{ id: 1, column01: "LINESTRING(1 2, 3 4)" }], sizeBytes: 1024, projectIds: [], inputs: null,
  owner: { name: "Ada", sqlName: "ada" }, qualifiedName: "trips",
};
const after: TableInspection = {
  ...before, geometryColumn: "geometry", geometryType: "LINESTRING", crsAssumed: true,
  columns: [...before.columns, { name: "geometry", type: "GEOMETRY" }],
  geometryRecord: { columns: ["column01"], format: "wkt", signal: "manual", rule: "manual", crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, unreadableCount: 0 },
};
const wkt: GeometryChoice = { format: "wkt", columns: ["column01"] };
const inspection = (over: Partial<GeometryInspection> = {}): GeometryInspection => ({
  tableId: "fixture", revision: "r1", columns: before.columns, geometryColumn: null, geometryRecord: null, currentChoice: null, mode: "unmodified",
  candidates: [{ columns: ["column01"], format: "wkt", signal: "content", rule: "content", strength: "strong", sample: { rows: 1, nonNull: 1, readable: 1 },
    crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, degreeCompatible: true, reasons: [], applied: false, sourceRetained: true }],
  ...over,
});
const answer: GeometryPreview = {
  tableId: "fixture", revision: "r1", choice: wkt, canApply: true, issues: [], rowCount: 1000, unreadableCount: 0, geometryType: "LINESTRING",
  extent: [1, 2, 3, 4], degreeCompatible: true,
  sample: { rows: [{ index: 0, values: { id: 1, column01: "LINESTRING(1 2, 3 4)" }, status: "readable" }], features: { type: "FeatureCollection", features: [] } },
};
const read = (table: TableInspection) => ({ ok: true, json: async () => table });
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Settle one hand-held promise inside React's act, and let its chain run. */
const settle = <T,>(d: Deferred<T>, value: T) => act(async () => { d.resolve(value); await flush(); });

describe("the dataset page reached at its open-with-panel address", () => {
  let host: ReturnType<typeof installDomHost>;
  let container: HostElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    host = installDomHost();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== "/api/tables/trips") throw new Error(`unexpected fetch ${String(input)}`);
      const d = fake.deferred<{ ok: boolean; json: () => Promise<unknown> }>();
      fake.reads.push(d);
      return d.promise;
    }));
    container = host.document.body.appendChild(host.document.createElement("div"));
    root = createRoot(container as unknown as Element);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.document.body.removeChild(container);
    vi.unstubAllGlobals();
    host.uninstall();
  });

  it("opens the panel once through the address; after Apply closes it, the re-read that remounts the detail leaves it closed", async () => {
    const dock = () => container.querySelector("[data-set-geometry-panel]");
    await act(async () => root.render(<TableDetailScreen name="trips" openGeometry />));
    expect(fake.reads).toHaveLength(1);
    await settle(fake.reads[0], read(before));
    // The detail mounted under the address: the panel opens on the read's facts.
    expect(fake.client.inspect).toHaveBeenCalledTimes(1);
    await settle(fake.inspects[0], inspection());
    expect(dock(), "the address opens the panel").not.toBeNull();
    await settle(fake.previews[0], answer);
    const apply = container.querySelectorAll("button").find((b) => b.textContent === "Apply");
    expect(apply?.disabled).toBe(false);
    await act(async () => { apply!.click(); await flush(); });
    expect(fake.sets).toHaveLength(1);
    // Apply succeeds, the panel closes and the page re-reads, which
    // renders the pending state and unmounts the detail.
    await settle(fake.sets[0], { table: { ...after, geometryCandidates: [] } as unknown as GeometrySetResult["table"], revision: "r2", currentChoice: wkt, mode: "set", extent: [1, 2, 3, 4] });
    expect(dock(), "closed on apply").toBeNull();
    expect(fake.reads, "the page re-reads after apply").toHaveLength(2);
    expect(container.textContent).toContain("Reading table");
    // The re-read lands and the detail mounts again under the same address.
    await settle(fake.reads[1], read(after));
    expect(container.querySelector("h1")?.textContent).toBe("trips");
    if (fake.inspects[1]) await settle(fake.inspects[1], inspection({ revision: "r2", geometryColumn: "geometry", geometryRecord: after.geometryRecord ?? null, currentChoice: wkt, mode: "set" }));
    expect(dock(), "the panel Apply closed stays closed once the re-read has landed").toBeNull();
    expect(fake.client.inspect, "the address opens once per dataset, not once per mount").toHaveBeenCalledTimes(1);
  });
});
